//! 只负责操作系统资源；所有子进程在首次 await 前就拥有清理守卫。

use super::contract::{TerminalSize, TerminalStream};
use super::io::{Reader, Writer};
use super::sandbox::{Launch, Policy};
use super::shell::{Initialization, Invocation};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill, killpg},
    unistd::{Pid, getpgid},
};
use pty_process::blocking::Pty;
use rustix::process::{WaitId, WaitIdOptions, WaitIdStatus, waitid};
use std::{
    os::{fd::AsFd, unix::process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
};

/// 守卫持有尚未回收的 PID；先处理整个进程组，再回收组长，避免 PID 重用竞态。
pub(super) struct OwnedChild {
    child: Child,
    pid: Pid,
    master: Option<Pty>,
    reaped: bool,
}

/// 完成同步启动的资源包；移交后台任务前任意失败都会释放其进程守卫。
pub(super) struct Started {
    pub(super) child: OwnedChild,
    pub(super) readers: Vec<(TerminalStream, Reader)>,
    pub(super) writer: Option<Writer>,
    pub(super) launch: Launch,
}

/// 管道和 PTY 使用互斥配置，避免出现“非 PTY 却带终端尺寸”的内部状态。
#[derive(Clone, Copy)]
pub(super) enum IoMode {
    Pipe { stdin: bool },
    Pty(TerminalSize),
}

pub(super) fn spawn(
    shell: Invocation<'_>,
    cwd: &Path,
    mode: IoMode,
    policy: &Policy,
    network: Option<&super::network::ProcessNetwork>,
) -> Result<Started, String> {
    match mode {
        IoMode::Pty(size) => spawn_pty(shell, cwd, size, policy, network),
        IoMode::Pipe { stdin } => spawn_pipe(shell, cwd, stdin, policy, network),
    }
}

fn spawn_pipe(
    shell: Invocation<'_>,
    cwd: &Path,
    stdin: bool,
    policy: &Policy,
    network: Option<&super::network::ProcessNetwork>,
) -> Result<Started, String> {
    let launch = Launch::new(policy, shell, cwd, None, network)?;
    let mut command = Command::new(&launch.program);
    command.args(&launch.args);
    if let Some(environment) = &launch.environment {
        command.env_clear().envs(environment);
    }
    let mut child = command
        .current_dir(cwd)
        .process_group(0)
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("终端命令启动失败：{e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let input = child.stdin.take();
    let child = OwnedChild::new(child, None)?;
    let writer = input.map(|input| Writer::new(input.into())).transpose()?;
    let readers = vec![
        (
            TerminalStream::Stdout,
            Reader::new(stdout.ok_or("终端缺少 stdout")?.into())?,
        ),
        (
            TerminalStream::Stderr,
            Reader::new(stderr.ok_or("终端缺少 stderr")?.into())?,
        ),
    ];
    Ok(Started {
        child,
        readers,
        writer,
        launch,
    })
}

fn spawn_pty(
    shell: Invocation<'_>,
    cwd: &Path,
    size: TerminalSize,
    policy: &Policy,
    network: Option<&super::network::ProcessNetwork>,
) -> Result<Started, String> {
    let (master, slave) =
        pty_process::blocking::open().map_err(|e| format!("PTY 分配失败：{e}"))?;
    master
        .resize(pty_process::Size::new(size.rows, size.columns))
        .map_err(|e| format!("PTY 尺寸设置失败：{e}"))?;
    let reader = Reader::new(
        master
            .as_fd()
            .try_clone_to_owned()
            .map_err(|e| format!("PTY 读取句柄创建失败：{e}"))?,
    )?;
    let writer = Writer::new(
        master
            .as_fd()
            .try_clone_to_owned()
            .map_err(|e| format!("PTY 输入句柄创建失败：{e}"))?,
    )?;
    let tty = nix::unistd::ttyname(&slave).map_err(|e| format!("PTY 路径读取失败：{e}"))?;
    let launch = Launch::new(policy, shell, cwd, Some(&tty), network)?;
    let mut command = pty_process::blocking::Command::new(&launch.program).args(&launch.args);
    if let Some(environment) = &launch.environment {
        command = command.env_clear().envs(environment);
    }
    let capture = matches!(shell.initialization, Initialization::Capture { .. });
    if capture {
        // 控制终端用于初始化，序列化使用独立 stdout；启动诊断不能混入可执行快照。
        command = command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    let mut child = command
        .current_dir(cwd)
        .env("TERM", "xterm-256color")
        .spawn(slave)
        .map_err(|e| format!("PTY 命令启动失败：{e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = OwnedChild::new(child, Some(master))?;
    let mut readers = vec![(TerminalStream::Terminal, reader)];
    if capture {
        readers.push((
            TerminalStream::Stdout,
            Reader::new(stdout.ok_or("环境采集缺少 stdout")?.into())?,
        ));
        readers.push((
            TerminalStream::Stderr,
            Reader::new(stderr.ok_or("环境采集缺少 stderr")?.into())?,
        ));
    }
    Ok(Started {
        child,
        readers,
        writer: Some(writer),
        launch,
    })
}

impl OwnedChild {
    pub(super) fn resize(&self, size: TerminalSize) -> Result<(), String> {
        self.master
            .as_ref()
            .ok_or("普通管道不支持终端尺寸调整")?
            .resize(pty_process::Size::new(size.rows, size.columns))
            .map_err(|e| format!("PTY 尺寸调整失败：{e}"))
    }

    fn new(mut child: Child, master: Option<Pty>) -> Result<Self, String> {
        let pid = i32::try_from(child.id()).ok().filter(|id| *id > 0);
        match pid {
            Some(pid) => Ok(Self {
                child,
                pid: Pid::from_raw(pid),
                master,
                reaped: false,
            }),
            None => {
                let kill = child.kill();
                let wait = child.wait();
                Err(format!(
                    "子进程没有有效 PID；终止结果：{kill:?}；回收结果：{wait:?}"
                ))
            }
        }
    }

    pub(super) fn poll(&self) -> Result<Option<WaitIdStatus>, String> {
        let pid = rustix::process::Pid::from_raw(self.pid.as_raw()).expect("进程守卫只持有正 PID");
        waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        )
        .map_err(|error| format!("终端退出状态读取失败：{error}"))
    }

    pub(super) fn signal(&self, signal: Signal) -> Result<(), String> {
        if self.reaped {
            return Ok(());
        }
        let foreground = self.foreground_group();
        // 先向组长组发信号；强制回收不能先杀前台任务，给交互 shell 留下继续执行的窗口。
        let group = send_signal(self.pid, signal);
        let foreground = foreground.and_then(|foreground| {
            if let Some(group) = foreground.filter(|group| *group != self.pid) {
                send_signal(group, signal)
            } else {
                Ok(())
            }
        });
        // 任一路径失败都必须继续清理其他目标；前台查询失败不能阻断组长回收。
        let child = self.signal_child(signal, group.is_ok());
        let errors: Vec<_> = [foreground, group, child]
            .into_iter()
            .filter_map(Result::err)
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }

    fn foreground_group(&self) -> Result<Option<Pid>, String> {
        // 交互程序可切换前台进程组；关闭时也终止当前前台任务。
        self.master
            .as_ref()
            .map(nix::unistd::tcgetpgrp)
            .transpose()
            .or_else(|error| match error {
                // 最后一个 slave 关闭后没有前台进程组；macOS 也可能成功返回零。
                Errno::ENOTTY | Errno::EIO | Errno::ENXIO => Ok(None),
                _ => Err(error),
            })
            .map(|group| group.filter(|pid| pid.as_raw() > 0))
            .map_err(|e| format!("PTY 前台进程组查询失败：{e}"))
    }

    fn signal_child(&self, signal: Signal, group_signalled: bool) -> Result<(), String> {
        match getpgid(Some(self.pid)) {
            Ok(group) if group == self.pid && group_signalled => return Ok(()),
            Err(Errno::ESRCH) => return Ok(()),
            _ => {}
        }
        // 子进程可主动改变进程组；PID 在 wait 前仍归守卫所有，但新组可能属于宿主，禁止广播。
        match kill(self.pid, signal) {
            Ok(()) | Err(Errno::ESRCH) => Ok(()),
            // macOS 在 poll 与 kill 之间进入退出态时也可能返回 EPERM；只接受已确认的退出。
            Err(Errno::EPERM) if self.poll()?.is_some() => Ok(()),
            Err(error) => Err(format!("终端子进程信号 {signal} 发送失败：{error}")),
        }
    }

    pub(super) fn reap(&mut self) -> Result<(), String> {
        // poll 使用 WNOWAIT 保留组长身份；清理遗留后代后才回收组长。
        let cleanup = self.signal(Signal::SIGKILL);
        if cleanup.is_err() && self.poll()?.is_none() {
            return cleanup;
        }
        self.child
            .wait()
            .map_err(|e| format!("终端回收失败：{e}"))?;
        self.reaped = true;
        self.master.take();
        cleanup
    }
}

fn send_signal(pid: Pid, signal: Signal) -> Result<(), String> {
    match killpg(pid, signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        #[cfg(target_os = "macos")]
        Err(Errno::EPERM) if crate::process::group_has_no_live_members(pid)? => Ok(()),
        Err(error) => Err(format!("终端进程组信号 {signal} 发送失败：{error}")),
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.reaped
            && let Err(error) = self.reap()
        {
            eprintln!("{error}");
        }
    }
}
