/**
 * macOS 自动化默认隐藏窗口；Linux 在 Xvfb 中必须映射窗口，布局与可见性回调才能推进。
 * Linux CI 使用 Xvfb 虚拟显示器，NOEMORI_TEST_WINDOW 可显式覆盖默认模式。
 * 子进程继承此环境，既不改用户会话，也不影响普通开发启动。
 */
process.env["NOEMORI_TEST_WINDOW"] ??= process.platform === "linux" ? "visible" : "hidden";
