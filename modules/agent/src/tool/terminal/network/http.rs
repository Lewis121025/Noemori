use super::{TerminalNetworkProtocol, TerminalNetworkTarget, connection::Connection};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use http::{Method, Request, Response, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{body::Incoming, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite};

type BodyError = Box<dyn std::error::Error + Send + Sync>;
type Body = BoxBody<Bytes, BodyError>;

/// HTTP 逐个请求授权；复用连接不能把后续不同主机的请求当成第一条连接的原始字节流。
pub(super) async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    client: S,
    connection: Arc<Connection>,
) -> Result<(), String> {
    let service = service_fn(move |request| {
        let connection = connection.clone();
        async move { Ok::<_, Infallible>(handle(request, connection).await) }
    });
    hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(10))
        .max_buf_size(32 * 1024)
        .max_headers(128)
        .serve_connection(TokioIo::new(client), service)
        .with_upgrades()
        .await
        .map_err(|error| error.to_string())
}

async fn handle(mut request: Request<Incoming>, connection: Arc<Connection>) -> Response<Body> {
    if !authenticated(&request, &connection) {
        let mut response = text(
            StatusCode::PROXY_AUTHENTICATION_REQUIRED,
            "此代理仅供拥有相应凭据的终端使用",
        );
        response.headers_mut().insert(
            header::PROXY_AUTHENTICATE,
            http::HeaderValue::from_static("Basic realm=\"Noemori\""),
        );
        return response;
    }
    let target = match target(&request) {
        Ok(target) => target,
        Err(error) => return text(StatusCode::BAD_REQUEST, &error),
    };
    let authority = if target.host.contains(':') {
        format!("[{}]", target.host)
    } else {
        target.host.clone()
    };
    let host = if target.port == 80 {
        authority
    } else {
        format!("{authority}:{}", target.port)
    };
    let host = match http::HeaderValue::from_str(&host) {
        Ok(host) => host,
        Err(error) => return text(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let upstream = match connection.connect(target).await {
        Ok(upstream) => upstream,
        Err(error) => return text(StatusCode::FORBIDDEN, &error),
    };
    if request.method() == Method::CONNECT {
        let state = connection.clone();
        connection.tasks.spawn(async move {
            tokio::select! {
                biased;
                _ = state.process.stop.cancelled() => {},
                result = hyper::upgrade::on(request) => match result {
                    Ok(client)=>tunnel(TokioIo::new(client),upstream,state).await,
                    Err(error)=>state.report(None,false,Some(error.to_string())),
                },
            }
        });
        return text(StatusCode::OK, "");
    }
    let upgrade = request.headers().contains_key(header::UPGRADE);
    let client_upgrade = upgrade.then(|| hyper::upgrade::on(&mut request));
    let path = request
        .uri()
        .path_and_query()
        .map_or("/", |path| path.as_str());
    let uri = match path.parse::<Uri>() {
        Ok(uri) => uri,
        Err(error) => return text(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    *request.uri_mut() = uri;
    request.headers_mut().remove(header::PROXY_AUTHORIZATION);
    request.headers_mut().remove("proxy-connection");
    if !upgrade && let Err(error) = remove_hop_headers(request.headers_mut()) {
        return text(StatusCode::BAD_REQUEST, &error);
    }
    // 上游 Host 必须来自已经校验的目标，不能被 Connection 标头删掉后落入其他虚拟主机。
    request.headers_mut().insert(header::HOST, host);
    let (mut sender, driver) =
        match hyper::client::conn::http1::handshake(TokioIo::new(upstream)).await {
            Ok(parts) => parts,
            Err(error) => return text(StatusCode::BAD_GATEWAY, &error.to_string()),
        };
    let state = connection.clone();
    connection.tasks.spawn(async move {
        tokio::select! { _ = state.process.stop.cancelled() => {}, outcome = driver.with_upgrades() => if let Err(error)=outcome { state.report(None,false,Some(error.to_string())); } }
    });
    let mut response = match sender.send_request(request).await {
        Ok(response) => response,
        Err(error) => return text(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    if response.status() == StatusCode::SWITCHING_PROTOCOLS
        && let Some(client_upgrade) = client_upgrade
    {
        let server_upgrade = hyper::upgrade::on(&mut response);
        let state = connection.clone();
        connection.tasks.spawn(async move {
            tokio::select! {
                biased;
                _ = state.process.stop.cancelled() => {},
                result = async { tokio::try_join!(client_upgrade,server_upgrade) } => match result {
                    Ok((client,server))=>tunnel(TokioIo::new(client),TokioIo::new(server),state).await,
                    Err(error)=>state.report(None,false,Some(error.to_string())),
                },
            }
        });
    } else if let Err(error) = remove_hop_headers(response.headers_mut()) {
        return text(StatusCode::BAD_GATEWAY, &error);
    }
    response.map(|body| {
        body.map_err(|error| -> BodyError { Box::new(error) })
            .boxed()
    })
}

async fn tunnel<A: AsyncRead + AsyncWrite + Unpin, B: AsyncRead + AsyncWrite + Unpin>(
    mut client: A,
    mut server: B,
    state: Arc<Connection>,
) {
    tokio::select! { biased; _=state.process.stop.cancelled()=>{}, outcome=tokio::io::copy_bidirectional(&mut client,&mut server)=>if let Err(error)=outcome { state.report(None,false,Some(error.to_string())); } }
}

fn target(request: &Request<Incoming>) -> Result<TerminalNetworkTarget, String> {
    let authority = request.uri().authority().ok_or("代理请求缺少目标主机")?;
    if authority.as_str().contains('@') {
        return Err("目标 URI 不能包含用户信息".into());
    }
    let connect = request.method() == Method::CONNECT;
    if !connect && !matches!(request.uri().scheme_str(), Some("http" | "ws")) {
        return Err("HTTP 代理仅接受绝对 HTTP/WS URI 或 CONNECT 隧道".into());
    }
    let port = if connect {
        authority.port_u16().ok_or("CONNECT 须明确目标端口")?
    } else {
        authority.port_u16().unwrap_or(80)
    };
    let target = TerminalNetworkTarget::new(authority.host(), port, TerminalNetworkProtocol::Tcp)
        .map_err(|error| error.to_string())?;
    if request.headers().get_all(header::HOST).iter().count() > 1 {
        return Err("Host 标头不能重复".into());
    }
    if let Some(host) = request.headers().get(header::HOST) {
        let authority = host
            .to_str()
            .map_err(|error| error.to_string())?
            .parse::<http::uri::Authority>()
            .map_err(|error| error.to_string())?;
        let header_target = TerminalNetworkTarget::new(
            authority.host(),
            authority
                .port_u16()
                .unwrap_or(if connect { port } else { 80 }),
            TerminalNetworkProtocol::Tcp,
        )
        .map_err(|error| error.to_string())?;
        if header_target != target || authority.as_str().contains('@') {
            return Err("Host 标头与实际目标不一致".into());
        }
    }
    Ok(target)
}

fn authenticated(request: &Request<Incoming>, connection: &Connection) -> bool {
    let mut values = request
        .headers()
        .get_all(header::PROXY_AUTHORIZATION)
        .iter();
    let Some(value) = values.next().and_then(|value| value.to_str().ok()) else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Some((scheme, encoded)) = value.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("basic") {
        return false;
    }
    let Ok(bytes) = STANDARD.decode(encoded) else {
        return false;
    };
    let Some(index) = bytes.iter().position(|byte| *byte == b':') else {
        return false;
    };
    connection.authenticated(&bytes[..index], &bytes[index + 1..])
}

fn remove_hop_headers(headers: &mut http::HeaderMap) -> Result<(), String> {
    let mut names = Vec::new();
    for value in headers.get_all(header::CONNECTION).iter() {
        for name in value
            .to_str()
            .map_err(|error| error.to_string())?
            .split(',')
        {
            names.push(
                name.trim()
                    .parse::<http::HeaderName>()
                    .map_err(|error| error.to_string())?,
            );
        }
    }
    for name in names {
        headers.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
    Ok(())
}
fn text(status: StatusCode, message: &str) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::copy_from_slice(message.as_bytes()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
}
