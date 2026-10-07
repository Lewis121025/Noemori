mod connection;
mod datagram_codec;
mod datagram_transport;
mod frames;
mod gateway;
mod http;
mod policy;
mod prefix;
#[cfg(target_os = "linux")]
mod relay_config;
mod session;
mod shared;
mod shared_handshake;
mod socks;
mod udp;
mod unix_policy;
mod upstream;
mod upstream_udp;
pub(in crate::tool::terminal) use connection::ProcessNetwork;
pub(in crate::tool::terminal) use gateway::Gateway;
pub use upstream::TerminalUpstreamProxy;

pub use policy::{
    TerminalNetworkApprovalDecision, TerminalNetworkApprovalRequest, TerminalNetworkApprover,
    TerminalNetworkConfig, TerminalNetworkDecision, TerminalNetworkObservation,
    TerminalNetworkPolicy, TerminalNetworkProtocol, TerminalNetworkRule, TerminalNetworkTarget,
    TerminalProxyListener, TerminalProxyListenerInfo, TerminalProxyProtocol,
};
pub(crate) use session::NetworkSession;
pub(in crate::tool::terminal) use shared::IngressRuntime;

#[cfg(test)]
#[path = "../../../../../test/agent/terminal/unit/network.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../../../test/agent/terminal/unit/datagrams.rs"]
mod datagram_tests;
