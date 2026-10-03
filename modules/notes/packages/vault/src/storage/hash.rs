//! 大附件的索引与导出共用有界缓冲；计算摘要不能物化整个文件。
use crate::{vault::hex_digest, Error};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

/// 流式复制并计算 SHA-256；只校验时使用 sink，取消在每个缓冲区之间检查。
/// # Errors
/// 输入输出失败、字节预算超限或进度回调拒绝。
pub(crate) fn transfer_hashed(
    source: &mut dyn Read,
    output: &mut dyn Write,
    limit: u64,
    progress: &mut dyn FnMut(usize) -> Result<(), Error>,
) -> Result<(String, u64), Error> {
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        progress(0)?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(
                u64::try_from(count)
                    .map_err(|_| Error::Io(std::io::Error::other("文件字节数超出范围")))?,
            )
            .ok_or_else(|| Error::Io(std::io::Error::other("文件字节计数溢出")))?;
        if total > limit {
            return Err(Error::Io(std::io::Error::other("文件超出字节预算")));
        }
        hash.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    Ok((hex_digest(&hash.finalize()), total))
}
