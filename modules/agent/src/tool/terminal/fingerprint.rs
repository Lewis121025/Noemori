use sha2::{Digest, Sha256};
use std::{os::unix::ffi::OsStrExt, path::Path};

/// 长度前缀使字段与列表不能互相拼接碰撞；指纹不保存环境变量明文。
pub(super) struct Fingerprint(Sha256);

impl Fingerprint {
    pub(super) fn new(domain: &str) -> Self {
        let mut hash = Self(Sha256::new());
        hash.bytes(domain.as_bytes());
        hash
    }

    pub(super) fn bytes(&mut self, bytes: &[u8]) {
        self.0.update((bytes.len() as u64).to_le_bytes());
        self.0.update(bytes);
    }

    pub(super) fn number(&mut self, number: u64) {
        self.0.update(number.to_le_bytes());
    }

    pub(super) fn path(&mut self, path: &Path) {
        self.bytes(path.as_os_str().as_bytes());
    }

    pub(super) fn finish(self) -> String {
        self.0
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}
