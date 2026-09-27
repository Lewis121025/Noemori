/**
 * 桌面自动化默认隐藏原生窗口；NOUS_TEST_WINDOW=visible 可显式恢复可见窗口。
 * 子进程继承此环境，既不改用户会话，也不影响普通开发启动。
 */
process.env["NOUS_TEST_WINDOW"] ??= "hidden";
