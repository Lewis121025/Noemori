//! 宿主直接持有 Node 和浏览器进程；辅助程序退出不会改变浏览器的所有权。

use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use std::{ffi::OsStr, io, process::Stdio, time::Duration};
use tokio::{io::BufReader, task::JoinHandle};

/// 保留进程角色和回收状态，已经退出的计算进程不再按进程组发送信号。
struct ManagedProcess {
    child: Box<dyn ChildWrapper>,
    reaped: bool,
    role: ProcessRole,
}

/// 两种进程的职责不同：辅助程序只计算，浏览器的操作系统子进程由宿主管理。
#[derive(Clone, Copy)]
pub(crate) enum ProcessRole {
    /// 只负责计算和转发，操作系统进程由宿主分配。
    Node,
    /// 独立的浏览器进程组，辅助程序退出后仍由宿主持有。
    Browser,
}

impl ProcessRole {
    fn name(self) -> &'static str {
        match self {
            Self::Node => "Node 辅助程序",
            Self::Browser => "浏览器",
        }
    }
}

/// 一次读取独占的进程、诊断任务与临时目录，按资源依赖的逆序释放。
#[derive(Default)]
pub(crate) struct Resources {
    children: Vec<ManagedProcess>,
    readers: Vec<JoinHandle<Result<(), String>>>,
    profiles: Vec<tempfile::TempDir>,
}

fn stopped(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || (cfg!(unix) && error.raw_os_error() == Some(3))
}

impl ManagedProcess {
    fn stop(&mut self) -> Result<(), String> {
        if self.reaped {
            return Ok(());
        }
        if matches!(self.role, ProcessRole::Node) {
            match self.child.try_wait() {
                Ok(Some(_)) => {
                    self.reaped = true;
                    return Ok(());
                }
                Ok(None) => {}
                Err(error) => return Err(format!("辅助程序退出状态读取失败：{error}")),
            }
        }
        match self.child.start_kill() {
            Ok(()) => Ok(()),
            Err(error) if stopped(&error) => Ok(()),
            Err(error) => {
                // Node 不拥有浏览器子进程，已交付退出状态后不再按进程组发送信号。
                if matches!(self.role, ProcessRole::Node)
                    && matches!(self.child.try_wait(), Ok(Some(_)))
                {
                    self.reaped = true;
                    Ok(())
                } else {
                    #[cfg(target_os = "macos")]
                    if error.raw_os_error() == Some(nix::libc::EPERM) {
                        let pid = self
                            .child
                            .id()
                            .and_then(|pid| i32::try_from(pid).ok())
                            .ok_or_else(|| {
                                format!(
                                    "{}进程组终止失败：{error}；缺少有效进程组标识",
                                    self.role.name()
                                )
                            })?;
                        let exited = crate::process::group_has_no_live_members(
                            nix::unistd::Pid::from_raw(pid),
                        )
                        .map_err(|reason| {
                            format!("{}进程组终止失败：{error}；{reason}", self.role.name())
                        })?;
                        // 信号失败只在整组均已退出时可接受；回收状态仍由后续 wait 确认。
                        if exited {
                            return Ok(());
                        }
                    }
                    Err(format!("{}进程组终止失败：{error}", self.role.name()))
                }
            }
        }
    }
}

impl Resources {
    /// 为宿主拥有的运行资源分配私有目录，最终回收与进程使用同一所有者。
    pub fn directory(&mut self, prefix: &str) -> Result<std::path::PathBuf, String> {
        let directory = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .map_err(|error| format!("运行目录创建失败：{error}"))?;
        let path = directory.path().to_owned();
        self.profiles.push(directory);
        Ok(path)
    }

    /// 启动后立即持有进程组，返回本次读取内的资源位置；启动失败返回明确原因。
    pub fn spawn(
        &mut self,
        program: &OsStr,
        role: ProcessRole,
        configure: impl FnOnce(&mut tokio::process::Command),
    ) -> Result<usize, String> {
        let mut command = CommandWrap::with_new(program, configure);
        command.wrap(KillOnDrop);
        #[cfg(unix)]
        command.wrap(process_wrap::tokio::ProcessGroup::leader());
        #[cfg(windows)]
        command.wrap(process_wrap::tokio::JobObject);
        let child = command
            .spawn()
            .map_err(|error| format!("进程无法启动：{error}"))?;
        let index = self.children.len();
        // 在任何 await 之前记录所有权，取消不能落入“已启动但无人负责”的窗口。
        self.children.push(ManagedProcess {
            child,
            reaped: false,
            role,
        });
        Ok(index)
    }

    /// 只访问已登记的资源，控制管道不会替换或转移进程所有权。
    pub fn child(&mut self, index: usize) -> &mut dyn ChildWrapper {
        self.children[index].child.as_mut()
    }

    /// 协议已无法继续时终止对应进程，让诊断管道结束；回收仍由宿主完成。
    pub fn stop(&mut self, index: usize) -> Result<(), String> {
        self.children[index].stop()
    }

    /// 确认进程退出后记录回收状态，等待错误保留给调用方。
    pub async fn wait(&mut self, index: usize) -> Result<std::process::ExitStatus, String> {
        let status = self.children[index]
            .child
            .wait()
            .await
            .map_err(|error| format!("等待进程退出失败：{error}"))?;
        self.children[index].reaped = true;
        Ok(status)
    }

    /// 分配临时浏览器与受控网络出口，返回控制租约；就绪前失败也保留清理责任。
    pub async fn browser(
        &mut self,
        executable: &OsStr,
        proxy_url: &str,
    ) -> Result<(u32, String), String> {
        self.browser_window(executable, proxy_url, true).await
    }

    /// 创建宿主独占的浏览器窗口；交互会话可保留窗口供人工接管，网络出口仍受控。
    pub async fn browser_window(
        &mut self,
        executable: &OsStr,
        proxy_url: &str,
        headless: bool,
    ) -> Result<(u32, String), String> {
        let proxy = reqwest::Url::parse(proxy_url).map_err(|_| "浏览器网络出口地址无效")?;
        if proxy.scheme() != "http"
            || proxy.host_str() != Some("127.0.0.1")
            || proxy.port().is_none()
            || !proxy.username().is_empty()
            || proxy.password().is_some()
        {
            return Err("浏览器只能使用本次辅助程序的本地受控出口".into());
        }
        let profile = tempfile::Builder::new()
            .prefix("noemori-web-browser-")
            .tempdir()
            .map_err(|error| format!("浏览器临时目录创建失败：{error}"))?;
        let profile_arg = format!("--user-data-dir={}", profile.path().display());
        self.profiles.push(profile);
        let index = self.spawn(executable, ProcessRole::Browser, |command| {
            // 固定实验配置，与当前 Playwright 的运行前提一致，避免实验改变请求拦截行为。
            command
                .args([
                    // 远程调试默认暴露 webdriver；通过浏览器自身选项减少该自动化信号。
                    "--disable-blink-features=AutomationControlled",
                    "--remote-debugging-port=0",
                    "--no-first-run",
                    "--disable-field-trial-config",
                    "--no-default-browser-check",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-breakpad",
                    "--disable-crash-reporter",
                    "--disable-quic",
                    "--disable-features=HttpsUpgrades,BlockOriginHeaderModificationOnRedirect",
                    // 只在宿主独占浏览器启用真实 WebMCP；工具调用仍需当前文档的独立审批。
                    "--enable-blink-features=WebMCP",
                    "--disable-extensions",
                    "--disable-default-apps",
                    "--disable-sync",
                    "--disable-component-extensions-with-background-pages",
                    "--password-store=basic",
                    "--use-mock-keychain",
                    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                    "--proxy-bypass-list=<-loopback>",
                ])
                .arg(format!("--proxy-server={proxy_url}"))
                .arg(profile_arg)
                .arg("about:blank")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            if headless {
                command.arg("--headless=new");
            }
        })?;
        let pid = self.child(index).id().ok_or("浏览器没有进程标识")?;
        let stderr = self
            .child(index)
            .stderr()
            .take()
            .ok_or("浏览器没有诊断管道")?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.readers
            .push(tokio::spawn(observe_browser(stderr, sender)));
        let endpoint = receiver.await.map_err(|_| "浏览器启动诊断中断")??;
        Ok((pid, endpoint))
    }

    /// 终止、回收进程并删除临时目录；任何异常清理原因都返回给调用方。
    pub async fn cleanup(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for process in self
            .children
            .iter_mut()
            .rev()
            .filter(|process| !process.reaped)
        {
            if let Err(error) = process.stop() {
                errors.push(error);
            }
            if process.reaped {
                continue;
            }
            match process.child.wait().await {
                Ok(_) => process.reaped = true,
                Err(error) => errors.push(format!("进程组回收失败：{error}")),
            }
        }
        for mut reader in self.readers.drain(..) {
            match tokio::time::timeout(Duration::from_secs(1), &mut reader).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => errors.push(error),
                Ok(Err(error)) => errors.push(format!("诊断任务退出失败：{error}")),
                Err(_) => {
                    reader.abort();
                    if let Err(error) = reader.await
                        && !error.is_cancelled()
                    {
                        errors.push(format!("诊断任务中止失败：{error}"));
                    }
                }
            }
        }
        for profile in self.profiles.drain(..) {
            if let Err(error) = profile.close() {
                errors.push(format!("浏览器临时目录清理失败：{error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }
}

async fn observe_browser(
    stderr: tokio::process::ChildStderr,
    sender: tokio::sync::oneshot::Sender<Result<String, String>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stderr);
    let mut sender = Some(sender);
    let mut bytes = 0usize;
    let result = async {
        loop {
            let line = super::io::frame_line(&mut reader, 64 * 1024 - bytes).await?;
            if line.is_empty() {
                return Ok(());
            }
            bytes += line.len();
            let text = std::str::from_utf8(&line)
                .map_err(|_| "浏览器诊断不是 UTF-8")?
                .trim();
            if let Some(endpoint) = text.strip_prefix("DevTools listening on ")
                && let Some(sender) = sender.take()
            {
                let valid = reqwest::Url::parse(endpoint)
                    .ok()
                    .filter(|url| url.scheme() == "ws" && url.host_str() == Some("127.0.0.1"));
                let result = valid
                    .map(|url| url.to_string())
                    .ok_or_else(|| "浏览器返回了无效控制地址".to_owned());
                if sender.send(result).is_err() {
                    return Ok(());
                }
            }
        }
    }
    .await;
    if let Some(sender) = sender {
        let reason = result
            .as_ref()
            .err()
            .cloned()
            .unwrap_or_else(|| "浏览器在控制地址就绪前退出".into());
        if sender.send(Err(reason)).is_err() {
            return result;
        }
    }
    result
}

impl Drop for Resources {
    fn drop(&mut self) {
        // 外层事件流被释放时无法 await；先终止拥有的进程组，再有界确认退出。
        for process in self
            .children
            .iter_mut()
            .rev()
            .filter(|process| !process.reaped)
        {
            if let Err(error) = process.stop() {
                eprintln!("Web 资源终止失败：{error}");
            }
            if process.reaped {
                continue;
            }
            for _ in 0..100 {
                match process.child.try_wait() {
                    Ok(Some(_)) => {
                        process.reaped = true;
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Err(error) => {
                        eprintln!("Web 资源回收失败：{error}");
                        break;
                    }
                }
            }
            if !process.reaped {
                eprintln!("Web 进程组未能在清理期限内确认退出");
            }
        }
        for reader in self.readers.drain(..) {
            reader.abort();
        }
        for profile in self.profiles.drain(..) {
            if let Err(error) = profile.close() {
                eprintln!("Web 临时目录清理失败：{error}");
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "../../../../../test/agent/web/integration/process.rs"]
mod tests;
