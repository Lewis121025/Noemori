use noemori_vault::{Error, Vault};
use std::fs;
use tempfile::TempDir;

fn open_temp_vault() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库目录");
    let index = TempDir::new().expect("索引目录");
    let vault = Vault::open(root.path(), index.path()).expect("打开库");
    (root, index, vault)
}

#[test]
fn identity_write_preserves_original_bytes() {
    let (root, _index, vault) = open_temp_vault();
    let original: &[u8] = b"# \xe4\xb8\xad\n\x00\xff";
    fs::write(root.path().join("note.md"), original).expect("写入夹具");

    let read = vault.read("note.md").expect("读取");
    assert_eq!(read, original);
    vault
        .write("note.md", &read, Some(&read))
        .expect("identity 写回");

    let after = fs::read(root.path().join("note.md")).expect("再读磁盘");
    assert_eq!(after, original);
}

#[test]
fn read_rejects_path_escape() {
    let (_root, _index, vault) = open_temp_vault();
    let err = vault.read("../secret.txt").expect_err("越界应失败");
    assert!(matches!(err, Error::PathEscape));
}

#[test]
fn write_rejects_path_escape() {
    let (_root, _index, vault) = open_temp_vault();
    let err = vault
        .write("../secret.txt", b"x", None)
        .expect_err("越界应失败");
    assert!(matches!(err, Error::PathEscape));
}
