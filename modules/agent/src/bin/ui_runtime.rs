//! 独立 JavaScript 执行进程；只能通过有类型的控制协议请求宿主能力。
fn main() {
    if let Err(error) = noemori_agent::tool::ui::run_guest() {
        eprintln!("UI 执行进程失败：{error}");
        std::process::exit(1);
    }
}
