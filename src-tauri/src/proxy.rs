//! In-process reverse proxy for the desktop app.
//!
//! Serves the bundled SPA (`dist/`) at `/` and forwards the three Canopy path
//! prefixes (`/mole`, `/hare`, `/fox`) to the configured backend, injecting the
//! `X-API-Key` header. Because the webview is pointed at this proxy's localhost
//! origin (see `main.rs`), the frontend's relative fetches and
//! `window.location.host`-derived WebSocket URLs resolve here unchanged, so no
//! frontend code differs between the web and desktop targets.
//!
//! This mirrors the web deployment's reverse proxy: the API key lives only in
//! the native process, never in the JS bundle.
//!
//! The proxy is only wired up in release builds (`tauri dev` uses the Vite dev
//! server + its proxy instead), so in a debug `cargo check` these functions
//! look unused; suppress that here rather than scattering per-item allows.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::CloseFrame as AxCloseFrame, ws::Message as AxumMsg, ws::WebSocket, State,
        WebSocketUpgrade,
    },
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode as TgCloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as TgCloseFrame;
use tokio_tungstenite::tungstenite::protocol::Message as WsMsg;
use tower_http::services::{ServeDir, ServeFile};

use crate::config::CanopyConfig;

/// Path prefixes that get forwarded to Canopy (everything else is static SPA).
const API_PREFIXES: [&str; 3] = ["/mole", "/hare", "/fox"];

/// Prefix forwarded to elog-plus. Unlike the Canopy prefixes the `/elog` prefix
/// is STRIPPED before forwarding and a different auth header is injected,
/// mirroring the web deployments' reverse-proxy contract (see vite.config.ts).
const ELOG_PREFIX: &str = "/elog";

fn has_prefix(path: &str, prefix: &str) -> bool {
    path == prefix || (path.starts_with(prefix) && path.as_bytes()[prefix.len()] == b'/')
}

fn is_api_path(path: &str) -> bool {
    API_PREFIXES.iter().any(|p| has_prefix(path, p))
}

fn is_elog_path(path: &str) -> bool {
    has_prefix(path, ELOG_PREFIX)
}

/// Where and how to forward one HTTP request.
struct Forward<'a> {
    /// Upstream base URL, no trailing slash.
    base: &'a str,
    /// Prefix to strip from the request path before joining onto `base`
    /// (`/elog` semantics); `None` forwards the path unchanged (Canopy).
    strip_prefix: Option<&'a str>,
    /// Auth header to inject; skipped when the value is empty.
    header_name: HeaderName,
    header_value: &'a str,
}

#[derive(Clone)]
struct ProxyState {
    config: Arc<CanopyConfig>,
    http: reqwest::Client,
}

/// Start the proxy on a fixed loopback port. Returns the bound address (so the
/// caller can point the webview at it). Runs the server on the given Tokio
/// runtime; the task lives for the process lifetime.
pub async fn bind(
    port: u16,
    dist_dir: PathBuf,
    config: CanopyConfig,
) -> std::io::Result<SocketAddr> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    let index = dist_dir.join("index.html");
    // Static SPA: serve files from dist/, falling back to index.html for any
    // unknown path (single-page app; there's no server router but this keeps
    // deep links / reloads working).
    let static_service = ServeDir::new(&dist_dir).fallback(ServeFile::new(index));

    let state = ProxyState {
        config: Arc::new(config),
        http: reqwest::Client::new(),
    };

    let app = Router::new()
        // API prefixes are matched inside the handler; catch-all sends
        // everything here and we branch on the path.
        .fallback(any(route))
        .with_state((state, Arc::new(static_service)));

    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!(%err, "proxy server exited");
        }
    });

    Ok(bound)
}

type SharedStatic = Arc<ServeDir<ServeFile>>;

/// Top-level router: API prefixes forward to Canopy, everything else is served
/// from the bundled SPA.
async fn route(
    State((state, static_service)): State<(ProxyState, SharedStatic)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ws: Option<WebSocketUpgrade>,
    body: Body,
) -> Response {
    let path = uri.path().to_string();

    // E-log (HTTP only, prefix stripped, different token header). When no elog
    // backend is configured, answer 502: the frontend's availability probe
    // treats any non-2xx as "e-log unavailable" and hides the post button —
    // same result as the web app without ELOG_BASE_URL. (A 2xx here would
    // wrongly enable the feature.)
    if is_elog_path(&path) {
        let Some(elog_url) = state.config.elog_url.as_deref() else {
            return (StatusCode::BAD_GATEWAY, "e-log backend not configured").into_response();
        };
        let forward = Forward {
            base: elog_url,
            strip_prefix: Some(ELOG_PREFIX),
            header_name: HeaderName::from_static("x-vouch-idp-accesstoken"),
            header_value: &state.config.elog_key,
        };
        return proxy_http(&state, method, uri, headers, body, forward).await;
    }

    if is_api_path(&path) {
        // WebSocket upgrade (live PV / formula streams) vs plain HTTP.
        if let Some(ws) = ws {
            return proxy_ws(state, uri, ws).await;
        }
        let forward = Forward {
            base: &state.config.canopy_url,
            strip_prefix: None,
            header_name: HeaderName::from_static("x-api-key"),
            header_value: &state.config.api_key,
        };
        return proxy_http(&state, method, uri, headers, body, forward).await;
    }

    // Static SPA asset. tower-http's ServeDir wants a Request; rebuild one.
    let req = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("static request");
    serve_static(static_service, req).await
}

async fn serve_static(service: SharedStatic, req: axum::http::Request<Body>) -> Response {
    use tower::ServiceExt;
    // ServeDir is infallible; clone the Arc'd service for this call.
    match (*service).clone().oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(err) => {
            tracing::error!(%err, "static serve error");
            (StatusCode::INTERNAL_SERVER_ERROR, "static serve error").into_response()
        }
    }
}

/// Cap on buffered request bodies. E-log posts multipart PNG attachments that
/// can total a few MB; 64 MiB is far above anything legitimate while still
/// bounding memory.
const MAX_REQUEST_BODY: usize = 64 * 1024 * 1024;

/// Forward an HTTP request upstream per `forward` (target base, optional
/// prefix strip, auth header), streaming the response body back.
async fn proxy_http(
    state: &ProxyState,
    method: Method,
    uri: Uri,
    mut headers: HeaderMap,
    body: Body,
    forward: Forward<'_>,
) -> Response {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(uri.path());
    // `/elog/v1/x?q=1` -> `/v1/x?q=1`: the prefix sits at the front of the
    // combined path+query string, so a plain strip_prefix is exact.
    let forwarded_path = match forward.strip_prefix {
        Some(prefix) => path_and_query.strip_prefix(prefix).unwrap_or(path_and_query),
        None => path_and_query,
    };
    let target = format!("{}{}", forward.base, forwarded_path);

    // Strip origin + hop-by-hop request headers; inject the auth header.
    headers.remove(http::header::HOST);
    headers.remove(http::header::CONTENT_LENGTH);
    let hop: Vec<HeaderName> = headers
        .keys()
        .filter(|n| is_hop_by_hop(n.as_str()))
        .cloned()
        .collect();
    for name in hop {
        headers.remove(&name);
    }
    if !forward.header_value.is_empty() {
        if let Ok(val) = HeaderValue::from_str(forward.header_value) {
            headers.insert(forward.header_name, val);
        }
    }

    let body_bytes = match axum::body::to_bytes(body, MAX_REQUEST_BODY).await {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(%err, "failed reading request body");
            return (StatusCode::BAD_REQUEST, "bad request body").into_response();
        }
    };

    let reqwest_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad method").into_response(),
    };

    let mut builder = state.http.request(reqwest_method, &target).body(body_bytes);
    for (name, value) in headers.iter() {
        builder = builder.header(name.as_str(), value.as_bytes());
    }

    match builder.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let mut resp = Response::builder().status(status.as_u16());
            // Copy response headers except hop-by-hop ones.
            for (name, value) in upstream.headers().iter() {
                if is_hop_by_hop(name.as_str()) {
                    continue;
                }
                resp = resp.header(name.as_str(), value.as_bytes());
            }
            let stream = upstream.bytes_stream();
            resp.body(Body::from_stream(stream))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(err) => {
            tracing::warn!(%err, target, "upstream request failed");
            (StatusCode::BAD_GATEWAY, format!("upstream error: {err}")).into_response()
        }
    }
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

/// Bridge a browser WebSocket to an upstream Canopy WebSocket, injecting the
/// X-API-Key header on the upstream connection and pumping frames both ways.
async fn proxy_ws(state: ProxyState, uri: Uri, ws: WebSocketUpgrade) -> Response {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(uri.path())
        .to_string();
    let upstream_url = format!("{}{}", state.config.ws_url(), path_and_query);
    let api_key = state.config.api_key.clone();

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = pump_ws(socket, upstream_url, api_key).await {
            tracing::warn!(%err, "ws proxy closed");
        }
    })
}

async fn pump_ws(
    client: WebSocket,
    upstream_url: String,
    api_key: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut request = upstream_url.into_client_request()?;
    if !api_key.is_empty() {
        request
            .headers_mut()
            .insert("X-API-Key", HeaderValue::from_str(&api_key)?);
    }
    let (upstream, _resp) = tokio_tungstenite::connect_async(request).await?;

    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    // client -> upstream. Close frames carry their code/reason across so the
    // upstream sees the browser's real close, not a synthetic empty one.
    let c2u = async {
        while let Some(Ok(msg)) = cl_rx.next().await {
            let out = match msg {
                AxumMsg::Text(t) => WsMsg::Text(t),
                AxumMsg::Binary(b) => WsMsg::Binary(b),
                AxumMsg::Ping(p) => WsMsg::Ping(p),
                AxumMsg::Pong(p) => WsMsg::Pong(p),
                AxumMsg::Close(frame) => {
                    // axum code is a bare u16; tungstenite's CloseCode::from is
                    // total over u16, so this cannot fail.
                    let mapped = frame.map(|f| TgCloseFrame {
                        code: TgCloseCode::from(f.code),
                        reason: f.reason,
                    });
                    let _ = up_tx.send(WsMsg::Close(mapped)).await;
                    break;
                }
            };
            if up_tx.send(out).await.is_err() {
                break;
            }
        }
    };

    // upstream -> client, same close-frame mapping in reverse.
    let u2c = async {
        while let Some(Ok(msg)) = up_rx.next().await {
            let out = match msg {
                WsMsg::Text(t) => AxumMsg::Text(t),
                WsMsg::Binary(b) => AxumMsg::Binary(b),
                WsMsg::Ping(p) => AxumMsg::Ping(p),
                WsMsg::Pong(p) => AxumMsg::Pong(p),
                WsMsg::Close(frame) => {
                    let mapped = frame.map(|f| AxCloseFrame {
                        code: f.code.into(),
                        reason: f.reason,
                    });
                    let _ = cl_tx.send(AxumMsg::Close(mapped)).await;
                    break;
                }
                WsMsg::Frame(_) => continue,
            };
            if cl_tx.send(out).await.is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = c2u => {},
        _ = u2c => {},
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_paths_matched() {
        assert!(is_api_path("/mole/v1/data"));
        assert!(is_api_path("/hare/v1/ws/pvs"));
        assert!(is_api_path("/fox/v1/validate"));
        assert!(is_api_path("/mole"));
    }

    #[test]
    fn non_api_paths_are_static() {
        assert!(!is_api_path("/"));
        assert!(!is_api_path("/index.html"));
        assert!(!is_api_path("/assets/app.js"));
        // Guard against a false prefix match.
        assert!(!is_api_path("/molecule"));
    }

    #[test]
    fn elog_paths_matched() {
        assert!(is_elog_path("/elog"));
        assert!(is_elog_path("/elog/v1/logbooks"));
        assert!(is_elog_path("/elog/v2/entries"));
        // False prefix + not part of the Canopy set.
        assert!(!is_elog_path("/elogbook"));
        assert!(!is_api_path("/elog/v1/logbooks"));
    }
}

// In-process end-to-end tests: real proxy (bind on an ephemeral port) against a
// real mock upstream (axum on an ephemeral port). No external network, CI-safe.
#[cfg(test)]
mod e2e {
    use super::*;
    use axum::extract::ws::{CloseFrame, Message, WebSocketUpgrade as Upgrade};
    use axum::routing::{get, post};
    use std::net::SocketAddr;

    /// Serve `router` on an ephemeral loopback port; returns the bound addr.
    async fn spawn_upstream(router: Router) -> SocketAddr {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        addr
    }

    fn config(canopy: SocketAddr, elog: Option<SocketAddr>) -> CanopyConfig {
        CanopyConfig {
            canopy_url: format!("http://{canopy}"),
            api_key: "secret123".into(),
            elog_url: elog.map(|a| format!("http://{a}")),
            elog_key: "elogtoken".into(),
        }
    }

    /// Start the proxy on an ephemeral port with a throwaway dist dir.
    async fn spawn_proxy(cfg: CanopyConfig, dist: PathBuf) -> SocketAddr {
        bind(0, dist, cfg).await.unwrap()
    }

    fn no_dist() -> PathBuf {
        std::env::temp_dir().join("trace-proxy-test-no-dist")
    }

    // Upstream echo: "<auth header or ->|<method>|<uri>".
    fn echo_router(auth_header: &'static str) -> Router {
        let handler = move |method: Method, uri: Uri, headers: HeaderMap| async move {
            format!(
                "{}|{}|{}",
                headers
                    .get(auth_header)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("-"),
                method,
                uri
            )
        };
        Router::new().fallback(any(handler))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forwards_canopy_with_api_key_path_unchanged() {
        let upstream = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(upstream, None), no_dist()).await;

        let body = reqwest::get(format!("http://{proxy}/mole/v1/data?binning=auto&n=1"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        // Key injected; path AND query forwarded unchanged.
        assert_eq!(body, "secret123|GET|/mole/v1/data?binning=auto&n=1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forwards_elog_with_token_and_stripped_prefix() {
        let elog = spawn_upstream(echo_router("x-vouch-idp-accesstoken")).await;
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy, Some(elog)), no_dist()).await;

        let body = reqwest::get(format!("http://{proxy}/elog/v1/logbooks?limit=5"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        // Token injected (not X-API-Key); /elog prefix stripped, query kept.
        assert_eq!(body, "elogtoken|GET|/v1/logbooks?limit=5");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn elog_multipart_body_round_trips() {
        // Upstream reports the content-type boundary marker and body size.
        let handler = |headers: HeaderMap, body: axum::body::Bytes| async move {
            let ct = headers
                .get(http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("-")
                .to_string();
            format!("{}|{}", ct, body.len())
        };
        let elog = spawn_upstream(Router::new().route("/v2/entries", post(handler))).await;
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy, Some(elog)), no_dist()).await;

        // Hand-rolled multipart (entry.json + one fake PNG part), matching the
        // shape PostToElogModal sends.
        let boundary = "trace-test-boundary";
        let png = vec![0x89u8, b'P', b'N', b'G', 0, 1, 2, 3];
        let mut payload = Vec::new();
        payload.extend_from_slice(
            format!(
                "--{boundary}\r\ncontent-disposition: form-data; name=\"entry\"; filename=\"entry.json\"\r\ncontent-type: application/json\r\n\r\n{{\"title\":\"t\"}}\r\n"
            )
            .as_bytes(),
        );
        payload.extend_from_slice(
            format!(
                "--{boundary}\r\ncontent-disposition: form-data; name=\"files\"; filename=\"plot.png\"\r\ncontent-type: image/png\r\n\r\n"
            )
            .as_bytes(),
        );
        payload.extend_from_slice(&png);
        payload.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let expected_len = payload.len();

        let client = reqwest::Client::new();
        let body = client
            .post(format!("http://{proxy}/elog/v2/entries"))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(payload)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        // Content-Type (incl. boundary) preserved and the body arrived intact.
        assert_eq!(
            body,
            format!("multipart/form-data; boundary={boundary}|{expected_len}")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn elog_unconfigured_is_502() {
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;

        let res = reqwest::get(format!("http://{proxy}/elog/v1/logbooks"))
            .await
            .unwrap();
        // Must be non-2xx so useElogConfig hides the feature; 502 = "no upstream".
        assert_eq!(res.status().as_u16(), 502);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn serves_spa_with_deep_link_fallback() {
        let dist = std::env::temp_dir().join(format!("trace-proxy-test-dist-{}", std::process::id()));
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<html>trace-spa</html>").unwrap();
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy, None), dist).await;

        let root = reqwest::get(format!("http://{proxy}/")).await.unwrap();
        assert_eq!(root.status().as_u16(), 200);
        assert!(root.text().await.unwrap().contains("trace-spa"));
        // Unknown deep link falls back to index.html (SPA routing).
        let deep = reqwest::get(format!("http://{proxy}/some/deep/link"))
            .await
            .unwrap();
        assert!(deep.text().await.unwrap().contains("trace-spa"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bridges_websocket_with_header_and_close_code() {
        // Upstream WS: first sends the api key it saw, echoes text, and answers
        // "bye" with a coded close frame.
        let ws_handler = |ws: Upgrade, headers: HeaderMap| async move {
            let key = headers
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("-")
                .to_string();
            ws.on_upgrade(move |mut socket| async move {
                socket.send(Message::Text(format!("key={key}"))).await.ok();
                while let Some(Ok(msg)) = socket.recv().await {
                    if let Message::Text(t) = msg {
                        if t == "bye" {
                            socket
                                .send(Message::Close(Some(CloseFrame {
                                    code: 4321,
                                    reason: "done".into(),
                                })))
                                .await
                                .ok();
                            break;
                        }
                        socket.send(Message::Text(t)).await.ok();
                    }
                }
            })
        };
        let canopy =
            spawn_upstream(Router::new().route("/hare/v1/ws/pvs", get(ws_handler))).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{proxy}/hare/v1/ws/pvs"))
            .await
            .unwrap();
        // Upstream saw the injected key (WS header injection).
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            WsMsg::Text("key=secret123".into())
        );
        // Frames pump both ways.
        ws.send(WsMsg::Text("hello".into())).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap(), WsMsg::Text("hello".into()));
        // Close code + reason survive the bridge (not collapsed to None).
        ws.send(WsMsg::Text("bye".into())).await.unwrap();
        match ws.next().await.unwrap().unwrap() {
            WsMsg::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 4321);
                assert_eq!(frame.reason, "done");
            }
            other => panic!("expected coded close frame, got {other:?}"),
        }
    }
}
