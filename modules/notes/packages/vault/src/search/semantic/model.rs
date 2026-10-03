//! 固定 Harrier ONNX 制品；文件哈希、输入模板和输出维度共同定义向量空间。

use crate::{Error, SearchCancellation};
use ort::{session::Session, value::Tensor};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
    time::Duration,
};
use tokenizers::Tokenizer;

pub(super) const DIMENSIONS: usize = 640;
pub(super) const MODEL_DIRECTORY: &str = "harrier-270m-d59c919d-f32-640";
pub(super) const VERSION: &str = "harrier-270m-d59c919d-f32-640-chunk-v4";
const REVISION: &str = "d59c919d0159aea2c19ed7d04288fcdd048d0f9c";
const PROMPT: &str =
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";
const FILES: [(&str, &str, u64); 3] = [
    (
        "onnx/model.onnx",
        "d5bff170c042556850e4941617bd45e05e7f2dd0868dc9e2beef05b8c5b62d06",
        182_338,
    ),
    (
        "onnx/model.onnx_data",
        "f27e5e94060e994a9d79be8be9910fc2513e0f9939d934103489a2156b0ff9a8",
        1_105_947_136,
    ),
    (
        "tokenizer.json",
        "ec95be298bea26f90370854faa650744c9fb0a04ca5e5ff95dd3913393ac5e45",
        20_323_311,
    ),
];

/// 推理只接受已核验模型；每次单条输入，限制后台批次的不可抢占时间和峰值内存。
pub(super) struct Harrier {
    tokenizer: Tokenizer,
    session: Session,
}

impl Harrier {
    /// 核验 root 中的固定制品后创建推理会话；取消、校验、文件读取及模型加载错误传播。
    pub fn open(root: &Path, token: &SearchCancellation) -> Result<Self, Error> {
        verify(root, token)?;
        let tokenizer = Tokenizer::from_file(root.join("tokenizer.json")).map_err(failure)?;
        let session = Session::builder()
            .map_err(failure)?
            .with_intra_threads(2)
            .map_err(failure)?
            .commit_from_file(root.join("onnx/model.onnx"))
            .map_err(failure)?;
        Ok(Self { tokenizer, session })
    }

    /// 编码 text，query 决定是否添加查询模板；返回 640 维 L2 归一化向量。
    /// 取消、超出 token 预算、推理失败或输出不符合向量契约时返回错误。
    pub fn encode(
        &mut self,
        text: &str,
        query: bool,
        token: &SearchCancellation,
    ) -> Result<Vec<f32>, Error> {
        token.check()?;
        let input = if query {
            format!("{PROMPT}{text}")
        } else {
            text.to_owned()
        };
        let encoded = self.tokenizer.encode(input, true).map_err(failure)?;
        if encoded.len() > 2048 {
            return Err(failure("模型输入超过应用的 2048 token 预算"));
        }
        let ids = encoded
            .get_ids()
            .iter()
            .map(|id| i64::from(*id))
            .collect::<Vec<_>>();
        let mask = vec![1_i64; ids.len()];
        let shape = [1_usize, ids.len()];
        let options = token.inference_options()?;
        let output = self.session.run_with_options(
            ort::inputs![
                "input_ids" => Tensor::from_array((shape, ids)).map_err(failure)?,
                "attention_mask" => Tensor::from_array((shape, mask)).map_err(failure)?,
            ],
            &options,
        );
        token.check()?;
        let output = output.map_err(failure)?;
        let value = output
            .get("sentence_embedding")
            .ok_or_else(|| failure("Harrier 制品缺少末 token 池化输出"))?;
        let (shape, values) = value.try_extract_tensor::<f32>().map_err(failure)?;
        if shape.as_ref() != [1, 640] {
            return Err(failure("Harrier 输出形状无效"));
        }
        normalize(values)
    }

    /// 标题段分别切块，重叠只发生在同一段内，避免两个主题共享一个语义向量。
    /// sections 是 body 的 UTF-8 字节边界；返回正文范围，边界或分词无效时返回错误。
    pub fn ranges(
        &self,
        body: &str,
        sections: &[usize],
    ) -> Result<Vec<std::ops::Range<usize>>, Error> {
        let mut boundaries = vec![0];
        for &start in sections {
            let previous = boundaries.last().copied().unwrap_or(0);
            if start < previous || !body.is_char_boundary(start) {
                return Err(failure("章节边界与检索正文不一致"));
            }
            if start > previous && start < body.len() {
                boundaries.push(start);
            }
        }
        boundaries.push(body.len());
        let mut ranges = Vec::new();
        for window in boundaries.windows(2) {
            let offset = window[0];
            ranges.extend(
                self.segment_ranges(&body[offset..window[1]])?
                    .into_iter()
                    .map(|range| offset + range.start..offset + range.end),
            );
        }
        Ok(ranges)
    }

    /// token 边界映射回正文；上下文预留预算，避免切块后被模型静默截断。
    fn segment_ranges(&self, body: &str) -> Result<Vec<std::ops::Range<usize>>, Error> {
        let encoded = self.tokenizer.encode(body, false).map_err(failure)?;
        let offsets = encoded.get_offsets();
        let mut result = Vec::new();
        let mut start = 0;
        while start < offsets.len() {
            let end = (start + 320).min(offsets.len());
            let from = offsets[start].0;
            let mut to = offsets[end - 1].1;
            // 优先使用靠近窗口末尾的段落边界，保留至少半个窗口的有效内容。
            if let Some(relative) = body[from..to].rfind('\n').filter(|_| end < offsets.len()) {
                if relative > (to - from) / 2 {
                    // 分隔符也要计入已消费范围，否则短段尾部会被重叠窗口反复处理。
                    to = from + relative + 1;
                }
            }
            let text = &body[from..to];
            let trimmed = text.trim();
            let leading = text.len() - text.trim_start().len();
            if !trimmed.is_empty() {
                result.push(from + leading..from + leading + trimmed.len());
            }
            if end == offsets.len() && to == offsets[end - 1].1 {
                break;
            }
            let consumed = offsets.partition_point(|(_, end)| *end <= to);
            start = consumed.saturating_sub(48).max(start + 1);
        }
        Ok(result)
    }
}

// 归一化以 f64 累加避免溢出，输出契约固定为 f32；单位向量分量均落在 [-1, 1]。
#[allow(clippy::cast_possible_truncation)]
/// 返回 values 的 L2 归一化副本；维度不符、非有限值或零范数均返回错误。
pub(super) fn normalize(values: &[f32]) -> Result<Vec<f32>, Error> {
    if values.len() != DIMENSIONS || values.iter().any(|v| !v.is_finite()) {
        return Err(failure("向量维度或数值无效"));
    }
    let norm = values
        .iter()
        .map(|v| f64::from(*v).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm <= f64::EPSILON {
        return Err(failure("模型返回零向量"));
    }
    Ok(values
        .iter()
        .map(|v| (f64::from(*v) / norm) as f32)
        .collect())
}

/// 检查 root 是否已发布就绪标记；这里只判断安装状态，加载时仍须核验制品。
pub(super) fn installed(root: &Path) -> bool {
    root.join("ready").is_file()
}

/// 将 source 中的固定制品导入 root，source 为空则下载；校验完成后原子替换目录。
/// 取消、网络、校验和文件系统错误传播，失败时不发布未核验制品。
pub(super) fn install(
    root: &Path,
    source: Option<&Path>,
    token: &SearchCancellation,
) -> Result<(), Error> {
    let parent = root
        .parent()
        .ok_or_else(|| failure("模型安装目录无父目录"))?;
    fs::create_dir_all(parent)?;
    let _installation = installation_lock(parent, token)?;
    let backup = root.with_extension("previous");
    if !root.exists() && backup.exists() {
        fs::rename(&backup, root)?;
    }
    if installed(root) {
        match verify(root, token) {
            Ok(()) => {
                if backup.exists() {
                    fs::remove_dir_all(backup)?;
                }
                return Ok(());
            }
            Err(Error::SearchCancelled) => return Err(Error::SearchCancelled),
            // 只修复缺失或校验不符的制品；权限及存储故障必须保留原始原因。
            Err(Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::InvalidData
                ) => {}
            Err(error) => return Err(error),
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".harrier-")
        .tempdir_in(parent)?;
    let client = reqwest::blocking::ClientBuilder::from(
        reqwest::Client::builder().read_timeout(Duration::from_secs(10)),
    )
    .connect_timeout(Duration::from_secs(20))
    .timeout(Duration::from_mins(30))
    .build()
    .map_err(failure)?;
    for (name, _, size) in FILES {
        token.check()?;
        let path = stage.path().join(name);
        fs::create_dir_all(path.parent().ok_or_else(|| failure("模型文件目录无效"))?)?;
        let mut input: Box<dyn Read> = if let Some(source) = source {
            Box::new(fs::File::open(source.join(name))?)
        } else {
            let url = format!("https://huggingface.co/onnx-community/harrier-oss-v1-270m-ONNX/resolve/{REVISION}/{name}");
            Box::new(
                client
                    .get(url)
                    .send()
                    .map_err(failure)?
                    .error_for_status()
                    .map_err(failure)?,
            )
        };
        let mut output = fs::File::create(path)?;
        let mut total = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            token.check()?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > size {
                return Err(failure("模型文件超过固定制品大小"));
            }
            output.write_all(&buffer[..count])?;
        }
        output.sync_all()?;
    }
    verify(stage.path(), token)?;
    let mut ready = fs::File::create(stage.path().join("ready"))?;
    ready.write_all(MODEL_DIRECTORY.as_bytes())?;
    ready.sync_all()?;
    token.check()?;
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    if root.exists() {
        fs::rename(root, &backup)?;
    }
    if let Err(error) = fs::rename(stage.path(), root) {
        if backup.exists() {
            fs::rename(&backup, root)?;
        }
        return Err(error.into());
    }
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    Ok(())
}

fn verify(root: &Path, token: &SearchCancellation) -> Result<(), Error> {
    for (name, expected, size) in FILES {
        let mut file = fs::File::open(root.join(name))?;
        if file.metadata()?.len() != size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("模型文件大小不符：{name}"),
            )
            .into());
        }
        let mut hash = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            token.check()?;
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if crate::vault::hex_digest(&hash.finalize()) != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("模型文件校验失败：{name}"),
            )
            .into());
        }
    }
    Ok(())
}

/// 将第三方 error 的可读原因保留在领域 IO 错误中，供语义失败状态展示。
pub(super) fn failure(error: impl std::fmt::Display) -> Error {
    io::Error::other(error.to_string()).into()
}

/// 模型目录跨库共享，磁盘锁保证多个运行时不会交叉发布安装目录。
fn installation_lock(parent: &Path, token: &SearchCancellation) -> Result<fs::File, Error> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(parent.join("harrier-install.lock"))?;
    loop {
        token.check()?;
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(10)),
            Err(fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}
