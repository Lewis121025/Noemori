//! 浏览器原生消息桥接入口；不向网页开放网络控制服务。
fn main() {
    if let Err(error) = noemori_agent::tool::ui::broker::run_native_bridge() {
        eprintln!("浏览器连接失败：{error}");
        std::process::exit(1);
    }
}
