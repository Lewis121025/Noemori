use super::*;
use libproc::libproc::{bsd_info::BSDInfo, proc_pid::pidinfo};

/// 信号失败后两次轮询仍未交付退出状态，复现 XNU 的退出到 waitpid 可回收之间的窗口。
#[derive(Debug)]
struct ExitTransition {
    inner: Box<dyn ChildWrapper>,
    pending_polls: usize,
    failed_signal: bool,
}

impl ChildWrapper for ExitTransition {
    fn inner(&self) -> &dyn ChildWrapper {
        self.inner.as_ref()
    }
    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        self.inner.as_mut()
    }
    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        self.inner
    }
    fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        if self.pending_polls > 0 {
            self.pending_polls -= 1;
            Ok(None)
        } else {
            self.inner.try_wait()
        }
    }
    fn start_kill(&mut self) -> io::Result<()> {
        if !self.failed_signal {
            self.failed_signal = true;
            Err(io::Error::from_raw_os_error(nix::libc::EPERM))
        } else {
            self.inner.start_kill()
        }
    }
}

fn resources(role: ProcessRole, script: &str, path: Option<&std::path::Path>) -> Resources {
    let mut resources = Resources::default();
    let index = resources
        .spawn(OsStr::new("/bin/sh"), role, |command| {
            command.args(["-c", script]);
            if let Some(path) = path {
                command.env("NOUS_TEST_CHILD_PID_PATH", path);
            }
        })
        .unwrap();
    assert_eq!(index, 0);
    let process = resources.children.pop().unwrap();
    // 没有 await 或裸 PID 的交接窗口，故障包装仍持有原进程守卫。
    resources.children.push(ManagedProcess {
        child: Box::new(ExitTransition {
            inner: process.child,
            pending_polls: 2,
            failed_signal: false,
        }),
        ..process
    });
    resources
}

async fn exiting(resources: &Resources) {
    let pid = i32::try_from(resources.children[0].child.id().unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(info) = pidinfo::<BSDInfo>(pid, 1)
                && (info.pbi_status == nix::libc::SZOMB || info.pbi_flags & 4 != 0)
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("受控子进程未进入退出状态");
}

#[tokio::test]
async fn exiting_groups_do_not_turn_a_waitable_exit_into_a_permission_failure() {
    for role in [ProcessRole::Node, ProcessRole::Browser] {
        let mut resources = resources(role, "exit 17", None);
        exiting(&resources).await;
        let stopped = resources.stop(0);
        let reaped_before_wait = resources.children[0].reaped;
        let status = resources.wait(0).await.unwrap();
        resources.cleanup().await.unwrap();
        assert!(stopped.is_ok(), "已退出进程组被误报为权限失败：{stopped:?}");
        assert!(!reaped_before_wait, "终止判断不能伪造 wait 的回收结果");
        assert_eq!(status.code(), Some(17));
    }
}

#[tokio::test]
async fn a_live_owned_process_does_not_hide_a_permission_failure() {
    let mut resources = resources(ProcessRole::Node, "exec sleep 60", None);
    let stopped = resources.stop(0);
    resources.cleanup().await.unwrap();
    assert!(stopped.is_err(), "存活进程的权限失败被忽略");
}

#[tokio::test]
async fn an_exited_group_leader_does_not_hide_a_live_descendant() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("child.pid");
    let mut resources = resources(
        ProcessRole::Browser,
        "sleep 60 & printf '%s' \"$!\" > \"$NOUS_TEST_CHILD_PID_PATH\"; exit 17",
        Some(&path),
    );
    exiting(&resources).await;
    let stopped = resources.stop(0);
    resources.cleanup().await.unwrap();
    assert!(stopped.is_err(), "组长退出不能代替整个进程组退出");
}
