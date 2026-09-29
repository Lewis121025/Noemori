//! 监视故障与同批变化一起到达时，核对磁盘不能清除故障身份。

use super::*;

#[test]
fn resource_watch_error_refreshes_disk_without_claiming_healthy() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    std::fs::write(root.path().join("new.md"), "# New\n\n[[target]]\n").unwrap();
    let event = watch_notification(&vault, root.path(), Err("系统监视故障".into()));
    assert_eq!(event.status, "watch-error");
    assert!(!event.healthy);
    assert!(event.paths.is_empty());
    assert_eq!(event.message.as_deref(), Some("系统监视故障"));
    let links = vault.links_from("new.md").unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].to_raw, "target");
}
