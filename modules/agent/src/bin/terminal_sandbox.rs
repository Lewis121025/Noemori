//! 独立、单线程的启动前导；关闭继承句柄后才执行系统沙箱，不能在宿主内修改描述符。

#[cfg(target_os = "linux")]
#[path = "../tool/terminal/network/linux.rs"]
mod network;

#[cfg(unix)]
fn main() {
    if let Err(error) = execute() {
        eprintln!("沙箱启动失败，命令未执行：{error}");
        std::process::exit(126);
    }
}

#[cfg(unix)]
fn execute() -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let mut args = std::env::args_os().skip(1);
    let first = args.next().ok_or("沙箱启动器缺少系统隔离程序")?;
    #[cfg(target_os = "linux")]
    if first == "--network-init" {
        return network::initialize(args);
    }
    #[cfg(target_os = "linux")]
    if first == "--network-relay" {
        return network::relay(args);
    }
    let deny_network = first == "--deny-network";
    let program = if deny_network {
        args.next().ok_or("沙箱启动器缺少系统隔离程序")?
    } else {
        first
    };
    let mut command = std::process::Command::new(program);
    #[cfg(target_os = "linux")]
    let filter = if deny_network {
        Some(network_filter()?)
    } else {
        None
    };
    #[cfg(target_os = "linux")]
    let keep = {
        use std::os::fd::AsRawFd;
        let fds: Vec<_> = filter.iter().map(AsRawFd::as_raw_fd).collect();
        if let Some(fd) = fds.first() {
            command.arg("--seccomp").arg(fd.to_string());
        }
        fds
    };
    #[cfg(not(target_os = "linux"))]
    let keep = {
        if deny_network {
            return Err("当前平台不支持 Linux seccomp 参数".into());
        }
        Vec::new()
    };
    command.args(args);
    // 此进程尚未创建线程；标记 CLOEXEC 保留 Rust 自身的执行错误通道，并防止句柄绕过文件策略。
    close_fds::set_fds_cloexec(3, &keep);
    let error = command.exec();
    Err(error.to_string())
}

/// 网络命名空间仍允许访问可见的路径型 Unix socket，因此禁网同时阻止新 socket 和 io_uring。
#[cfg(target_os = "linux")]
fn network_filter() -> Result<std::fs::File, String> {
    use seccompiler::{BpfProgram, SeccompAction, SeccompFilter};
    use std::{
        collections::BTreeMap,
        io::{Seek, Write},
    };
    let calls = [
        nix::libc::SYS_socket,
        nix::libc::SYS_connect,
        nix::libc::SYS_io_uring_setup,
        nix::libc::SYS_io_uring_enter,
        nix::libc::SYS_io_uring_register,
    ];
    let mut rules = BTreeMap::new();
    for call in calls {
        rules.insert(call, Vec::new());
        // x32 与 x86_64 共用审计架构标识，必须同时覆盖带 ABI 标志的调用号。
        #[cfg(target_arch = "x86_64")]
        rules.insert(call | 0x4000_0000, Vec::new());
    }
    let architecture = std::env::consts::ARCH
        .try_into()
        .map_err(|e| format!("不支持的沙箱架构：{e}"))?;
    let program: BpfProgram = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(nix::libc::EPERM.unsigned_abs()),
        architecture,
    )
    .map_err(|e| format!("禁网规则无效：{e}"))?
    .try_into()
    .map_err(|e| format!("禁网规则编译失败：{e}"))?;
    let mut file = tempfile::tempfile().map_err(|e| format!("禁网规则文件创建失败：{e}"))?;
    for instruction in program {
        let mut bytes = Vec::with_capacity(8);
        bytes.extend(instruction.code.to_ne_bytes());
        bytes.push(instruction.jt);
        bytes.push(instruction.jf);
        bytes.extend(instruction.k.to_ne_bytes());
        file.write_all(&bytes)
            .map_err(|e| format!("禁网规则写入失败：{e}"))?;
    }
    file.rewind()
        .map_err(|e| format!("禁网规则定位失败：{e}"))?;
    nix::fcntl::fcntl(
        &file,
        nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::empty()),
    )
    .map_err(|e| format!("禁网规则句柄传递失败：{e}"))?;
    Ok(file)
}

#[cfg(not(unix))]
fn main() {
    eprintln!("终端沙箱只支持 macOS/Linux");
    std::process::exit(126);
}
