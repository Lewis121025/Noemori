use super::*;
use std::process::Stdio;
use tokio::io::AsyncReadExt;

#[tokio::test]
async fn dropping_store_releases_its_lock_even_when_a_child_inherited_the_descriptor() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rules.json");
    let store = TerminalApprovalStore::open(&path).unwrap();
    // 用子进程标准输入稳定复现 fork 到 exec 之间继承锁描述符的窗口。
    let inherited = store._lock.file.try_clone().unwrap();
    let mut child = tokio::process::Command::new("/bin/sh")
        .args(["-c", "printf r; exec sleep 30"])
        .stdin(Stdio::from(inherited))
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut ready = [0];
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        child.stdout.as_mut().unwrap().read_exact(&mut ready),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(ready, *b"r");
    assert!(child.try_wait().unwrap().is_none());
    assert!(TerminalApprovalStore::open(&path).is_err());
    drop(store);
    let reopened = TerminalApprovalStore::open(&path)
        .expect("父进程释放规则库后，继承描述符不能继续持有其许可锁");
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    assert!(TerminalApprovalStore::open(&path).is_err());
    drop(reopened);
    assert!(TerminalApprovalStore::open(&path).is_ok());
}
