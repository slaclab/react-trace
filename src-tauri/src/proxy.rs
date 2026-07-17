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
    extract::{ws::Message as AxumMsg, ws::WebSocket, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message as WsMsg;
use tower_http::services::{ServeDir, ServeFile};

use crate::config::CanopyConfig;

/// Path prefixes that get forwarded to Canopy (everything else is static SPA).
const API_PREFIXES: [&str; 3] = ["/mole", "/hare", "/fox"];

fn is_api_path(path: &str) -> bool {
    API_PREFIXES
        .iter()
        .any(|p| path == *p || path.starts_with(&format!("{p}/")))
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
    if !is_api_path(&path) {
        // Static SPA asset. tower-http's ServeDir wants a Request; rebuild one.
        let req = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .expect("static request");
        return serve_static(static_service, req).await;
    }

    // WebSocket upgrade (live PV / formula streams) vs plain HTTP.
    if let Some(ws) = ws {
        return proxy_ws(state, uri, ws).await;
    }
    proxy_http(state, method, uri, headers, body).await
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

/// Forward an HTTP request to Canopy with X-API-Key injected, streaming the
/// response body back.
async fn proxy_http(
    state: ProxyState,
    method: Method,
    uri: Uri,
    mut headers: HeaderMap,
    body: Body,
) -> Response {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(uri.path());
    let target = format!("{}{}", state.config.canopy_url, path_and_query);

    // Strip hop-by-hop / origin headers; inject the key.
    headers.remove(http::header::HOST);
    headers.remove(http::header::CONTENT_LENGTH);
    if !state.config.api_key.is_empty() {
        if let Ok(val) = HeaderValue::from_str(&state.config.api_key) {
            headers.insert(HeaderName::from_static("x-api-key"), val);
        }
    }

    let body_bytes = match axum::body::to_bytes(body, usize::MAX).await {
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

    // client -> upstream
    let c2u = async {
        while let Some(Ok(msg)) = cl_rx.next().await {
            let out = match msg {
                AxumMsg::Text(t) => WsMsg::Text(t),
                AxumMsg::Binary(b) => WsMsg::Binary(b),
                AxumMsg::Ping(p) => WsMsg::Ping(p),
                AxumMsg::Pong(p) => WsMsg::Pong(p),
                AxumMsg::Close(_) => {
                    let _ = up_tx.send(WsMsg::Close(None)).await;
                    break;
                }
            };
            if up_tx.send(out).await.is_err() {
                break;
            }
        }
    };

    // upstream -> client
    let u2c = async {
        while let Some(Ok(msg)) = up_rx.next().await {
            let out = match msg {
                WsMsg::Text(t) => AxumMsg::Text(t),
                WsMsg::Binary(b) => AxumMsg::Binary(b),
                WsMsg::Ping(p) => AxumMsg::Ping(p),
                WsMsg::Pong(p) => AxumMsg::Pong(p),
                WsMsg::Close(_) => {
                    let _ = cl_tx.send(AxumMsg::Close(None)).await;
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
}
