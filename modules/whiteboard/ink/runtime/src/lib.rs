//! 静态笔迹分类：原始向量等比栅格化，CPU FP32 推理；几何修复由编辑器独立校验。

use image::{GrayImage, imageops::FilterType};
use ort::{session::Session, value::Tensor};
use sha2::{Digest, Sha256};
use std::{error::Error, path::Path};
use tiny_skia::{FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};

/// 训练与部署共用的类别顺序；不得随意排序。
pub const LABELS: [&str; 8] = [
    "line",
    "circle",
    "ellipse",
    "arc",
    "rectangle",
    "triangle",
    "arrow",
    "other",
];
/// 固定候选的权重散列；切换模型须重新验证分类顺序、预处理与质量。
pub const MODEL_SHA256: &str = "adb4e298df627314306fa99971c00b0ea4d5e273e5cc099d29bd4c986b807e89";
type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// 一个 CPU 分类会话；调用方负责串行运行与生命周期，不阻塞 UI 线程。
pub struct ShapeClassifier {
    session: Session,
}

impl ShapeClassifier {
    /// 读取并校验候选权重，最多使用四个 CPU 工作线程；损坏或不兼容模型返回错误。
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path)?;
        if format!("{:x}", Sha256::digest(&bytes)) != MODEL_SHA256 {
            return Err("图形识别权重与已验证候选不一致".into());
        }
        let session = Session::builder()?
            .with_intra_threads(4)?
            .with_inter_threads(1)?
            .commit_from_memory(&bytes)?;
        Ok(Self { session })
    }

    /// 分类一个完整的连续笔迹；非法、退化采样或推理输出异常返回错误。
    pub fn classify(&mut self, points: &[[f64; 2]]) -> Result<(usize, f64)> {
        self.classify_image(&rasterize(points)?)
    }

    /// 分类 224×224 灰度图，用于跨语言的像素与模型一致性验证；尺寸无效返回错误。
    pub fn classify_image(&mut self, image: &GrayImage) -> Result<(usize, f64)> {
        let logits = self.logits(image)?;
        let (index, maximum) = logits
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .ok_or("图形分类没有输出")?;
        let denominator: f64 = logits
            .iter()
            .map(|value| f64::from(value - maximum).exp())
            .sum();
        Ok((index, 1.0 / denominator))
    }

    /// 返回固定类别顺序的 FP32 logits；仅接受训练约定的 224 方图，输出异常时返回错误。
    pub fn logits(&mut self, image: &GrayImage) -> Result<Vec<f32>> {
        if image.dimensions() != (224, 224) {
            return Err("图形分类图像尺寸无效".into());
        }
        let mean = [0.485_f32, 0.456, 0.406];
        let std = [0.229_f32, 0.224, 0.225];
        let mut input = Vec::with_capacity(3 * 224 * 224);
        for channel in 0..3 {
            input.extend(
                image
                    .as_raw()
                    .iter()
                    .map(|pixel| (f32::from(*pixel) / 255.0 - mean[channel]) / std[channel]),
            );
        }
        let tensor = Tensor::from_array(([1_usize, 3, 224, 224], input.into_boxed_slice()))?;
        let output = self.session.run(ort::inputs!["images" => tensor])?;
        let (shape, values) = output["logits"].try_extract_tensor::<f32>()?;
        if shape.as_ref() != [1, 8] || values.iter().any(|v| !v.is_finite()) {
            return Err("图形分类输出无效".into());
        }
        Ok(values.to_vec())
    }
}

/// 将已分组的连续笔迹等比居中，黑线白底、16 像素留白和三倍超采样；非法输入返回错误。
pub fn rasterize(points: &[[f64; 2]]) -> Result<GrayImage> {
    rasterize_paths(&[points])
}

/// 栅格化已明确分组的静态对象，用于训练数据与端侧一致性验证；不负责推断多笔归属。
pub fn rasterize_paths(paths: &[&[[f64; 2]]]) -> Result<GrayImage> {
    let points: Vec<_> = paths.iter().flat_map(|path| path.iter().copied()).collect();
    if paths.is_empty()
        || paths.iter().any(|p| p.is_empty())
        || !(2..=8192).contains(&points.len())
        || points
            .iter()
            .flatten()
            .any(|v| !v.is_finite() || v.abs() > 10_000_000.0)
    {
        return Err("图形识别采样无效".into());
    }
    let low = [0, 1].map(|axis| points.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min));
    let high = [0, 1].map(|axis| {
        points
            .iter()
            .map(|p| p[axis])
            .fold(f64::NEG_INFINITY, f64::max)
    });
    let size = (high[0] - low[0]).max(high[1] - low[1]);
    if size <= 0.0 {
        return Err("图形识别采样没有跨度".into());
    }
    let center = [0, 1].map(|axis| (low[axis] + high[axis]) / 2.0);
    let pixel = |p: &[f64; 2]| {
        [0, 1].map(|axis| (((p[axis] - center[axis]) * 192.0 / size + 112.0) * 3.0) as f32)
    };
    let mut pixmap = Pixmap::new(672, 672).ok_or("无法分配图形图像")?;
    pixmap.fill(tiny_skia::Color::WHITE);
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    let mut builder = PathBuilder::new();
    // 固定正反方向，使静态轮廓不携带笔画方向特征。
    let mut canonical: Vec<_> = paths
        .iter()
        .map(|path| {
            let reversed = path
                .iter()
                .rev()
                .zip(path.iter())
                .map(|(a, b)| a[0].total_cmp(&b[0]).then_with(|| a[1].total_cmp(&b[1])))
                .find(|order| !order.is_eq())
                .is_some_and(|order| order.is_lt());
            if reversed {
                path.iter().rev().copied().collect::<Vec<_>>()
            } else {
                path.to_vec()
            }
        })
        .collect();
    canonical.sort_by(|a, b| {
        a.iter()
            .zip(b)
            .map(|(a, b)| a[0].total_cmp(&b[0]).then_with(|| a[1].total_cmp(&b[1])))
            .find(|order| !order.is_eq())
            .unwrap_or_else(|| a.len().cmp(&b.len()))
    });
    let mut dots = Vec::new();
    for path in canonical {
        if path.iter().all(|point| point == &path[0]) {
            dots.push(pixel(&path[0]));
            continue;
        }
        for (i, point) in path.iter().enumerate() {
            let at = pixel(point);
            if i == 0 {
                builder.move_to(at[0], at[1]);
            } else {
                builder.line_to(at[0], at[1]);
            }
        }
    }
    if let Some(path) = builder.finish() {
        pixmap.stroke_path(
            &path,
            &paint,
            &Stroke {
                width: 9.0,
                line_cap: LineCap::Round,
                line_join: LineJoin::Round,
                ..Stroke::default()
            },
            Transform::identity(),
            None,
        );
    }
    for at in dots {
        let dot = PathBuilder::from_circle(at[0], at[1], 4.5).ok_or("无法构造点笔画")?;
        pixmap.fill_path(&dot, &paint, FillRule::Winding, Transform::identity(), None);
    }
    let gray = GrayImage::from_raw(
        672,
        672,
        pixmap
            .data()
            .as_chunks::<4>()
            .0
            .iter()
            .map(|p| p[0])
            .collect(),
    )
    .ok_or("图形栅格缓冲区无效")?;
    Ok(image::imageops::resize(
        &gray,
        224,
        224,
        FilterType::Lanczos3,
    ))
}
