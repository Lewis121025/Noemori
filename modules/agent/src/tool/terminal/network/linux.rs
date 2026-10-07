#[path = "relay_config.rs"]
mod config;
#[path = "frames.rs"]
mod frames;
#[path = "linux_udp.rs"]
mod udp;

use config::RelayConfig;
use std::{
    ffi::OsString,
    io::{Read, Write},
    os::{fd::AsFd, unix::process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;

/// 隔离命名空间内先启动受保护的转发进程，再限制命令；客户端不能自行创建 Unix socket。
pub(super) fn initialize(mut args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let path = args.next().ok_or("受控网络初始化缺少配置")?;
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
        return Err("受控网络初始化缺少参数终止符".into());
    }
    let program = args.next().ok_or("受控网络初始化缺少实际程序")?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let child = Command::new(executable)
        .arg("--network-relay")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut relay = OwnedRelay(child);
    let mut output = relay.0.stdout.take().ok_or("网络转发初始化缺少响应管道")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = [0; 6];
    let mut position = 0;
    while position < ready.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("命名空间代理初始化超时，命令未执行".into());
        }
        let mut fds = [nix::poll::PollFd::new(
            output.as_fd(),
            nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLHUP,
        )];
        nix::poll::poll(
            &mut fds,
            nix::poll::PollTimeout::try_from(remaining).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if fds[0].revents().is_some_and(|flags| {
            flags.intersects(nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLHUP)
        }) {
            let count = output
                .read(&mut ready[position..])
                .map_err(|error| error.to_string())?;
            if count == 0 {
                return Err("命名空间代理在就绪前退出，命令未执行".into());
            }
            position += count;
        }
    }
    if &ready != b"READY\n" {
        return Err("命名空间代理返回无效响应，命令未执行".into());
    }
    drop(output);
    seccompiler::apply_filter(&filter()?)
        .map_err(|error| format!("受控网络系统限制安装失败：{error}"))?;
    close_fds::set_fds_cloexec(3, &[]);
    let error = Command::new(program).args(args).exec();
    Err(error.to_string())
}

/// 转发进程只能把本命名空间连接送入已认证的宿主网关；其内存及句柄不能由命令窃取。
pub(super) fn relay(mut args: impl Iterator<Item = OsString>) -> Result<(), String> {
    nix::sys::prctl::set_dumpable(false).map_err(|error| error.to_string())?;
    let path = args.next().ok_or("网络转发缺少配置")?;
    if args.next().is_some() {
        return Err("网络转发包含额外参数".into());
    }
    let bytes = std::fs::read(Path::new(&path)).map_err(|error| error.to_string())?;
    if bytes.len() > 4096 {
        return Err("网络转发配置超出预算".into());
    }
    let config: RelayConfig = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if !config.gateway.is_absolute()
        || config.password.len() != 32
        || !config.password.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("网络转发配置无效".into());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:3128").await.map_err(|error|error.to_string())?;
        let datagrams=Arc::new(tokio::net::UdpSocket::bind("127.0.0.1:3128").await.map_err(|error|error.to_string())?);
        let config=Arc::new(config);
        println!("READY"); std::io::stdout().flush().map_err(|error|error.to_string())?;
        let slots=Arc::new(tokio::sync::Semaphore::new(128));
        let mut tasks=tokio::task::JoinSet::new();
        tasks.spawn(udp::run(datagrams,config.clone()));
        loop {
            tokio::select! {
                result=tasks.join_next(),if !tasks.is_empty()=>if let Some(result)=result { match result { Ok(Ok(()))=>{}, Ok(Err(error))=>eprintln!("命名空间网络转发失败：{error}"), Err(error)=>return Err(format!("命名空间网络转发任务失败：{error}")) } },
                incoming=listener.accept()=>{
                    let (mut client,_)=incoming.map_err(|error|error.to_string())?;
                    let Ok(permit)=slots.clone().try_acquire_owned() else { continue; };
                    let gateway=config.gateway.clone(); let password=config.password.clone();
                    tasks.spawn(async move {
                        let _permit=permit;
                        let mut server=tokio::net::UnixStream::connect(gateway).await.map_err(|error|error.to_string())?;
                        server.write_all(password.as_bytes()).await.map_err(|error|error.to_string())?;
                        tokio::io::copy_bidirectional(&mut client,&mut server).await.map_err(|error|error.to_string())?;
                        Ok::<_,String>(())
                    });
                },
            }
        }
    })
}

/// 初始化失败必须回收转发进程；exec 成功后进程树归命名空间所有，PID 1 退出会回收全部后代。
struct OwnedRelay(Child);
impl Drop for OwnedRelay {
    fn drop(&mut self) {
        if let Err(error) = self.0.kill()
            && error.kind() != std::io::ErrorKind::InvalidInput
        {
            eprintln!("网络转发停止失败：{error}");
        }
        if let Err(error) = self.0.wait() {
            eprintln!("网络转发回收失败：{error}");
        }
    }
}

fn filter() -> Result<seccompiler::BpfProgram, String> {
    use seccompiler::{
        SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule,
    };
    let mut rules = std::collections::BTreeMap::new();
    let families = SeccompRule::new(
        [nix::libc::AF_INET, nix::libc::AF_INET6]
            .into_iter()
            .map(|family| {
                SeccompCondition::new(
                    0,
                    SeccompCmpArgLen::Dword,
                    SeccompCmpOp::Ne,
                    u64::try_from(family).expect("系统 socket 家族常量必须为非负数"),
                )
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    rules.insert(nix::libc::SYS_socket, vec![families.clone()]);
    #[cfg(target_arch = "x86_64")]
    rules.insert(nix::libc::SYS_socket | 0x4000_0000, vec![families]);
    // 私有 stream socketpair 用于事件循环唤醒；datagram socketpair 可重新连接外部 Unix 路径，必须拒绝。
    let pair = SeccompRule::new(
        [
            0,
            nix::libc::SOCK_NONBLOCK,
            nix::libc::SOCK_CLOEXEC,
            nix::libc::SOCK_NONBLOCK | nix::libc::SOCK_CLOEXEC,
        ]
        .into_iter()
        .map(|flags| {
            SeccompCondition::new(
                1,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::Ne,
                u64::try_from(nix::libc::SOCK_STREAM | flags).expect("socket 类型常量必须为非负数"),
            )
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    rules.insert(nix::libc::SYS_socketpair, vec![pair.clone()]);
    #[cfg(target_arch = "x86_64")]
    rules.insert(nix::libc::SYS_socketpair | 0x4000_0000, vec![pair]);
    // io_uring 和句柄复制不能绕过 socket 策略；命令也不能读取转发进程的内存。
    for call in [
        nix::libc::SYS_io_uring_setup,
        nix::libc::SYS_io_uring_enter,
        nix::libc::SYS_io_uring_register,
        nix::libc::SYS_pidfd_getfd,
        nix::libc::SYS_ptrace,
    ] {
        rules.insert(call, vec![]);
        #[cfg(target_arch = "x86_64")]
        rules.insert(call | 0x4000_0000, vec![]);
    }
    SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(nix::libc::EPERM.unsigned_abs()),
        std::env::consts::ARCH
            .try_into()
            .map_err(|error| format!("不支持的网络沙箱架构：{error}"))?,
    )
    .map_err(|error| error.to_string())?
    .try_into()
    .map_err(|error| format!("受控网络规则编译失败：{error}"))
}
