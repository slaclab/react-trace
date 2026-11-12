//! In-process reverse proxy for the desktop app.
//!
//! Serves the bundled SPA (`dist/`) at `/` and forwards the Canopy path
//! prefixes the frontend uses (`/mole`, `/hare`, `/fox`, `/magpie`, `/vole`)
//! to the configured backend, injecting the `X-API-Key` header. Because the webview is pointed at this proxy's localhost
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
    body::{Body, HttpBody},
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
/// Keep in sync with the Canopy entries in vite.config.ts `server.proxy`: a
/// prefix missing here falls through to the SPA and gets index.html back.
const API_PREFIXES: [&str; 5] = ["/mole", "/hare", "/fox", "/magpie", "/vole"];

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
    /// Address the listener is bound to; requests must be addressed to it
    /// (see [`is_own_origin`]).
    bound: SocketAddr,
}

/// Host names the proxy answers to on its bound port. The webview uses
/// `127.0.0.1`; `localhost` is accepted for a local browser pointed at the app.
const LOCAL_HOSTS: [&str; 2] = ["127.0.0.1", "localhost"];

fn is_local_authority(authority: &str, port: u16) -> bool {
    LOCAL_HOSTS
        .iter()
        .any(|host| authority == format!("{host}:{port}"))
}

/// Whether a request is addressed to this proxy's own origin.
///
/// - `Host` must name the bound port on a [`LOCAL_HOSTS`] name. This rejects
///   DNS rebinding, where a foreign site's name resolves to 127.0.0.1 and the
///   browser treats the proxy as same-origin with that site.
/// - `Origin`, when present, must be `http://` plus such an authority. This
///   rejects pages on other origins: WebSocket upgrades are not covered by
///   CORS, and cross-site form POSTs to `/elog` would otherwise go out with
///   the injected token. `Origin: null` (sandboxed frames, `file://`) is
///   rejected too.
///
/// A missing `Origin` is allowed: browsers omit it on same-origin GETs, and a
/// non-browser local client can set any header it likes, so it is inside the
/// trust boundary described in the README either way.
fn is_own_origin(headers: &HeaderMap, port: u16) -> bool {
    let host_ok = headers
        .get(http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| is_local_authority(host, port));
    if !host_ok {
        return false;
    }
    match headers.get(http::header::ORIGIN) {
        None => true,
        Some(origin) => origin
            .to_str()
            .ok()
            .and_then(|o| o.strip_prefix("http://"))
            .is_some_and(|authority| is_local_authority(authority, port)),
    }
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

    // Never follow redirects upstream: reqwest keeps custom headers such as
    // X-API-Key and x-vouch-idp-accesstoken when a redirect changes host. The
    // 3xx goes back to the webview instead, with same-upstream locations
    // mapped back onto the proxy (see `rewrite_location`).
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(std::io::Error::other)?;

    let state = ProxyState {
        config: Arc::new(config),
        http,
        bound,
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

    // Checked before anything else, including WebSocket upgrades: a rejected
    // upgrade gets this 403 instead of a 101 and never reaches upstream.
    if !is_own_origin(&headers, state.bound.port()) {
        tracing::warn!(
            host = ?headers.get(http::header::HOST),
            origin = ?headers.get(http::header::ORIGIN),
            path,
            "rejected request not addressed to the proxy's own origin"
        );
        return (
            StatusCode::FORBIDDEN,
            "request not addressed to this app's origin",
        )
            .into_response();
    }

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

/// Forward an HTTP request upstream per `forward` (target base, optional
/// prefix strip, auth header), streaming the request body up and the response
/// body back.
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
        Some(prefix) => path_and_query
            .strip_prefix(prefix)
            .unwrap_or(path_and_query),
        None => path_and_query,
    };
    let target = format!("{}{}", forward.base, forwarded_path);

    // Strip origin + hop-by-hop request headers; inject the auth header.
    // Content-Length stays: the body is streamed, and hyper frames a streamed
    // body by a Content-Length it is given, so a fixed-length upload goes
    // upstream with the same length. Without one (a chunked upload) it goes
    // up chunked.
    headers.remove(http::header::HOST);
    strip_hop_by_hop(&mut headers);
    if !forward.header_value.is_empty() {
        if let Ok(val) = HeaderValue::from_str(forward.header_value) {
            headers.insert(forward.header_name.clone(), val);
        }
    }

    let reqwest_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad method").into_response(),
    };

    let mut builder = state.http.request(reqwest_method, target.as_str());
    // Stream the body through rather than reading it into memory first, so a
    // large e-log upload isn't held whole. A request with no body gets none
    // upstream either, instead of an empty chunked one.
    if !body.is_end_stream() {
        builder = builder.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    for (name, value) in headers.iter() {
        builder = builder.header(name.as_str(), value.as_bytes());
    }

    match builder.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let mut resp = Response::builder().status(status.as_u16());
            // Copy response headers except hop-by-hop ones, mapping a
            // same-upstream Location back onto the proxy.
            let mut up_headers = upstream.headers().clone();
            strip_hop_by_hop(&mut up_headers);
            for (name, value) in up_headers.iter() {
                if name == http::header::LOCATION {
                    let rewritten = value
                        .to_str()
                        .ok()
                        .and_then(|loc| rewrite_location(loc, &target, &forward));
                    if let Some(loc) = rewritten {
                        resp = resp.header(name, loc);
                        continue;
                    }
                }
                resp = resp.header(name, value);
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

/// Headers that apply to a single connection and are never forwarded
/// (RFC 9110 section 7.6.1, plus the legacy `keep-alive` and
/// `proxy-connection`).
const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Remove hop-by-hop headers: the fixed [`HOP_BY_HOP`] list plus every field
/// named in `Connection` (`Connection: x-local-state` makes `x-local-state`
/// hop-by-hop too). Tokens are read from all `Connection` values before the
/// header itself is removed.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let nominated: Vec<HeaderName> = headers
        .get_all(http::header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|token| HeaderName::from_bytes(token.trim().as_bytes()).ok())
        .collect();
    for name in nominated {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

/// Map an upstream `Location` back onto the proxy, like nginx's
/// `proxy_redirect default`. The value is resolved against the upstream
/// request URL (`target`), so absolute, path-absolute and relative forms all
/// work. When the result is on the configured upstream base, the proxy path
/// is returned (`base` replaced by the stripped prefix, so e-log paths get
/// `/elog` back): the browser's follow-up then comes through the proxy, which
/// re-injects the key. Anything else (another host, port or scheme, or a path
/// outside the base) returns `None` and is passed through unchanged; the
/// browser follows it without any of the proxy's credentials.
fn rewrite_location(location: &str, target: &str, forward: &Forward<'_>) -> Option<String> {
    let base = reqwest::Url::parse(forward.base).ok()?;
    let resolved = reqwest::Url::parse(target).ok()?.join(location).ok()?;
    if resolved.origin() != base.origin() {
        return None;
    }
    let rest = resolved
        .path()
        .strip_prefix(base.path().trim_end_matches('/'))?;
    if !(rest.is_empty() || rest.starts_with('/')) {
        return None;
    }
    let mut out = format!("{}{rest}", forward.strip_prefix.unwrap_or(""));
    if out.is_empty() {
        out.push('/');
    }
    if let Some(query) = resolved.query() {
        out.push('?');
        out.push_str(query);
    }
    if let Some(fragment) = resolved.fragment() {
        out.push('#');
        out.push_str(fragment);
    }
    Some(out)
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
        assert!(is_api_path("/magpie/v1/configs"));
        assert!(is_api_path("/vole/v1/health"));
        assert!(is_api_path("/mole"));
    }

    /// The desktop proxy must forward the same Canopy prefixes as the Vite dev
    /// proxy; a prefix missing here would get the SPA's index.html instead.
    #[test]
    fn api_prefixes_match_vite_dev_proxy() {
        let vite = include_str!("../../vite.config.ts");
        let mut vite_prefixes: Vec<&str> = vite
            .lines()
            .filter_map(|line| line.trim().strip_prefix('\''))
            .filter_map(|rest| rest.split_once("': {").map(|(key, _)| key))
            .filter(|key| key.starts_with('/') && *key != ELOG_PREFIX)
            .collect();
        vite_prefixes.sort_unstable();
        let mut ours = API_PREFIXES.to_vec();
        ours.sort_unstable();
        assert!(
            !vite_prefixes.is_empty(),
            "no proxy keys found in vite.config.ts"
        );
        assert_eq!(ours, vite_prefixes);
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

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn own_origin_accepts_bound_authority() {
        for host in ["127.0.0.1:5178", "localhost:5178"] {
            // No Origin (same-origin GET, non-browser client).
            assert!(is_own_origin(&headers(&[("host", host)]), 5178));
            for origin in ["http://127.0.0.1:5178", "http://localhost:5178"] {
                assert!(is_own_origin(
                    &headers(&[("host", host), ("origin", origin)]),
                    5178
                ));
            }
        }
    }

    #[test]
    fn own_origin_rejects_foreign_host_or_origin() {
        // Missing Host, DNS-rebound name, wrong port.
        assert!(!is_own_origin(&headers(&[]), 5178));
        assert!(!is_own_origin(
            &headers(&[("host", "attacker.example:5178")]),
            5178
        ));
        assert!(!is_own_origin(
            &headers(&[("host", "127.0.0.1:5179")]),
            5178
        ));
        assert!(!is_own_origin(&headers(&[("host", "127.0.0.1")]), 5178));
        // Right Host, foreign or opaque Origin.
        for origin in [
            "https://attacker.example",
            "http://attacker.example:5178",
            "https://127.0.0.1:5178",
            "http://127.0.0.1:5179",
            "http://127.0.0.1:5178.attacker.example",
            "null",
        ] {
            assert!(
                !is_own_origin(
                    &headers(&[("host", "127.0.0.1:5178"), ("origin", origin)]),
                    5178
                ),
                "origin {origin} accepted"
            );
        }
    }

    #[test]
    fn strips_connection_nominated_headers() {
        let mut map = headers(&[
            ("connection", "keep-alive, X-Local-State"),
            ("connection", " x-other ,,"),
            ("x-local-state", "1"),
            ("x-other", "1"),
            ("keep-alive", "timeout=5"),
            ("transfer-encoding", "chunked"),
            ("proxy-connection", "keep-alive"),
            ("x-end-to-end", "1"),
            ("content-type", "text/plain"),
        ]);
        strip_hop_by_hop(&mut map);
        let mut left: Vec<&str> = map.keys().map(|k| k.as_str()).collect();
        left.sort_unstable();
        assert_eq!(left, ["content-type", "x-end-to-end"]);
    }

    fn fwd<'a>(base: &'a str, strip_prefix: Option<&'a str>) -> Forward<'a> {
        Forward {
            base,
            strip_prefix,
            header_name: HeaderName::from_static("x-api-key"),
            header_value: "",
        }
    }

    #[test]
    fn location_on_canopy_upstream_maps_to_proxy_path() {
        let canopy = fwd("http://canopy.example:8000", None);
        let target = "http://canopy.example:8000/mole/v1/data/?n=1";
        for (location, expected) in [
            (
                "http://canopy.example:8000/mole/v1/data?n=1",
                "/mole/v1/data?n=1",
            ),
            // Host case and explicit default-less forms compare as one origin.
            ("http://CANOPY.example:8000/mole/x", "/mole/x"),
            ("/mole/v1/data?n=1", "/mole/v1/data?n=1"),
            ("../other", "/mole/v1/other"),
            ("http://canopy.example:8000", "/"),
            ("http://canopy.example:8000/x#frag", "/x#frag"),
        ] {
            assert_eq!(
                rewrite_location(location, target, &canopy).as_deref(),
                Some(expected),
                "{location}"
            );
        }
    }

    #[test]
    fn location_on_elog_upstream_gets_prefix_back() {
        // Base with a path: only locations under it map back.
        let elog = fwd("https://elog.example/api", Some("/elog"));
        let target = "https://elog.example/api/v1/entries";
        assert_eq!(
            rewrite_location("/api/v1/entries/42", target, &elog).as_deref(),
            Some("/elog/v1/entries/42")
        );
        assert_eq!(
            rewrite_location("https://elog.example/api", target, &elog).as_deref(),
            Some("/elog")
        );
        assert_eq!(rewrite_location("/apix/v1", target, &elog), None);
        assert_eq!(rewrite_location("/login", target, &elog), None);
        // Base without a path: an upstream-relative path gets /elog prepended.
        let bare = fwd("http://elog.example:8080", Some("/elog"));
        assert_eq!(
            rewrite_location("/v1/new", "http://elog.example:8080/v1/old", &bare).as_deref(),
            Some("/elog/v1/new")
        );
    }

    #[test]
    fn location_off_upstream_is_left_alone() {
        let canopy = fwd("http://canopy.example:8000", None);
        let target = "http://canopy.example:8000/mole/v1/data";
        for location in [
            "http://attacker.example/steal",
            "//attacker.example/steal",
            "https://canopy.example:8000/mole/x",
            "http://canopy.example:8001/mole/x",
        ] {
            assert_eq!(
                rewrite_location(location, target, &canopy),
                None,
                "{location}"
            );
        }
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

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
    async fn forwards_magpie_and_vole_with_api_key() {
        let upstream = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(upstream, None), no_dist()).await;

        for path in ["/magpie/v1/configs?app=trace", "/vole/v1/health"] {
            let body = reqwest::get(format!("http://{proxy}{path}"))
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert_eq!(body, format!("secret123|GET|{path}"));
        }
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
    async fn request_body_streams_to_upstream() {
        // The client only sends its second chunk once upstream has the first.
        // A proxy that read the whole body before forwarding would never pass
        // the first one on, and the request would time out.
        let first_seen = Arc::new(tokio::sync::Notify::new());
        let handler = {
            let first_seen = first_seen.clone();
            move |body: Body| {
                let first_seen = first_seen.clone();
                async move {
                    let mut chunks = body.into_data_stream();
                    let mut got = Vec::new();
                    while let Some(chunk) = chunks.next().await {
                        got.extend_from_slice(&chunk.unwrap());
                        first_seen.notify_one();
                    }
                    String::from_utf8(got).unwrap()
                }
            }
        };
        let elog = spawn_upstream(Router::new().route("/v2/entries", post(handler))).await;
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy, Some(elog)), no_dist()).await;

        let chunks = futures_util::stream::once(async { Ok::<_, std::io::Error>("first,") }).chain(
            futures_util::stream::once(async move {
                first_seen.notified().await;
                Ok("second")
            }),
        );
        let send = reqwest::Client::new()
            .post(format!("http://{proxy}/elog/v2/entries"))
            .body(reqwest::Body::wrap_stream(chunks))
            .send();
        let res = tokio::time::timeout(Duration::from_secs(10), send)
            .await
            .expect("upstream never got the first chunk: the proxy buffered the body")
            .unwrap();
        assert_eq!(res.text().await.unwrap(), "first,second");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn request_body_keeps_its_framing() {
        // Upstream reports "<content-length>|<transfer-encoding>|<body length>".
        let handler = |headers: HeaderMap, body: axum::body::Bytes| async move {
            let get = |name: HeaderName| {
                headers
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("-")
                    .to_string()
            };
            format!(
                "{}|{}|{}",
                get(http::header::CONTENT_LENGTH),
                get(http::header::TRANSFER_ENCODING),
                body.len()
            )
        };
        let canopy = spawn_upstream(Router::new().fallback(any(handler))).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;
        let client = reqwest::Client::new();
        let url = format!("http://{proxy}/mole/v1/data");
        let send = |req: reqwest::RequestBuilder| async move {
            req.send().await.unwrap().text().await.unwrap()
        };

        // No body: none upstream either, not an empty chunked one.
        assert_eq!(send(client.get(&url)).await, "-|-|0");
        assert_eq!(
            send(client.post(&url).header("content-length", "0")).await,
            "0|-|0"
        );
        // A fixed-length body keeps its Content-Length instead of going up
        // chunked.
        assert_eq!(send(client.post(&url).body("hello")).await, "5|-|5");
        // A chunked upload has no length to keep, so it goes up chunked.
        let chunks = futures_util::stream::iter(["hel", "lo"].map(Ok::<_, std::io::Error>));
        assert_eq!(
            send(client.post(&url).body(reqwest::Body::wrap_stream(chunks))).await,
            "-|chunked|5"
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
        let dist =
            std::env::temp_dir().join(format!("trace-proxy-test-dist-{}", std::process::id()));
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
        let canopy = spawn_upstream(Router::new().route("/hare/v1/ws/pvs", get(ws_handler))).await;
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
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            WsMsg::Text("hello".into())
        );
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

    /// Counts requests and echoes the X-API-Key it saw ("-" if none). Stands
    /// in for an upstream that must (or must not) be reached.
    fn counting_router(hits: Arc<AtomicUsize>) -> Router {
        Router::new().fallback(any(move |headers: HeaderMap| {
            let hits = hits.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                headers
                    .get("x-api-key")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("-")
                    .to_string()
            }
        }))
    }

    fn no_follow() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn redirect_to_foreign_host_is_not_followed() {
        let hits = Arc::new(AtomicUsize::new(0));
        let foreign = spawn_upstream(counting_router(hits.clone())).await;
        let to = format!("http://{foreign}/steal");
        let redirect = {
            let to = to.clone();
            move || async move { (StatusCode::FOUND, [(http::header::LOCATION, to)]) }
        };
        let canopy = spawn_upstream(Router::new().route("/mole/v1/go", get(redirect))).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;

        // The proxy hands the 302 back untouched instead of following it.
        let res = no_follow()
            .get(format!("http://{proxy}/mole/v1/go"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 302);
        assert_eq!(res.headers()[http::header::LOCATION], to.as_str());
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "proxy followed the redirect"
        );

        // A client that follows it reaches the foreign host without the key.
        let body = reqwest::get(format!("http://{proxy}/mole/v1/go"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "-");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn same_upstream_redirect_comes_back_through_proxy() {
        // Absolute redirect built from the Host the upstream saw, the way
        // FastAPI's trailing-slash redirects are.
        let redirect = |headers: HeaderMap| async move {
            let host = headers[http::header::HOST].to_str().unwrap().to_string();
            (
                StatusCode::TEMPORARY_REDIRECT,
                [(
                    http::header::LOCATION,
                    format!("http://{host}/mole/v1/new?x=1"),
                )],
            )
        };
        let canopy =
            spawn_upstream(echo_router("x-api-key").route("/mole/v1/old", get(redirect))).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;

        let res = no_follow()
            .get(format!("http://{proxy}/mole/v1/old"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 307);
        assert_eq!(res.headers()[http::header::LOCATION], "/mole/v1/new?x=1");

        // Followed, the second hop goes through the proxy and gets the key.
        let body = reqwest::get(format!("http://{proxy}/mole/v1/old"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "secret123|GET|/mole/v1/new?x=1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn elog_relative_redirect_gets_prefix_back() {
        let redirect = || async { (StatusCode::FOUND, [(http::header::LOCATION, "/v1/new")]) };
        let elog =
            spawn_upstream(echo_router("x-vouch-idp-accesstoken").route("/v1/old", get(redirect)))
                .await;
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy, Some(elog)), no_dist()).await;

        let res = no_follow()
            .get(format!("http://{proxy}/elog/v1/old"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.headers()[http::header::LOCATION], "/elog/v1/new");
        let body = reqwest::get(format!("http://{proxy}/elog/v1/old"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "elogtoken|GET|/v1/new");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn websocket_from_foreign_origin_is_rejected() {
        let upgrades = Arc::new(AtomicUsize::new(0));
        let ws_handler = {
            let upgrades = upgrades.clone();
            move |ws: Upgrade| {
                let upgrades = upgrades.clone();
                async move {
                    upgrades.fetch_add(1, Ordering::SeqCst);
                    ws.on_upgrade(|mut socket| async move {
                        socket.send(Message::Text("hi".into())).await.ok();
                    })
                }
            }
        };
        let canopy = spawn_upstream(Router::new().route("/hare/v1/ws/pvs", get(ws_handler))).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;
        let request = |origin: &str| {
            let mut req = format!("ws://{proxy}/hare/v1/ws/pvs")
                .into_client_request()
                .unwrap();
            req.headers_mut()
                .insert("origin", HeaderValue::from_str(origin).unwrap());
            req
        };

        // A page on another origin gets 403 instead of 101.
        match tokio_tungstenite::connect_async(request("https://attacker.example"))
            .await
            .map(|_| ())
        {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                assert_eq!(res.status().as_u16(), 403)
            }
            other => panic!("expected 403, got {other:?}"),
        }

        // The app's own origin (either local host name) is bridged.
        let own = format!("http://localhost:{}", proxy.port());
        let (mut ws, _) = tokio_tungstenite::connect_async(request(&own))
            .await
            .unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap(), WsMsg::Text("hi".into()));
        // Only the accepted upgrade ever reached upstream.
        assert_eq!(upgrades.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn http_from_foreign_origin_is_rejected() {
        let hits = Arc::new(AtomicUsize::new(0));
        let elog = spawn_upstream(counting_router(hits.clone())).await;
        let canopy = spawn_upstream(counting_router(hits.clone())).await;
        let proxy = spawn_proxy(config(canopy, Some(elog)), no_dist()).await;

        // Cross-site form POST to the e-log (would carry the injected token).
        let res = reqwest::Client::new()
            .post(format!("http://{proxy}/elog/v2/entries"))
            .header("origin", "https://attacker.example")
            .header("content-type", "multipart/form-data; boundary=x")
            .body("--x--\r\n")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 403);
        // Cross-origin read of Canopy data, and an opaque origin.
        for origin in ["https://attacker.example", "null"] {
            let res = reqwest::Client::new()
                .get(format!("http://{proxy}/mole/v1/data"))
                .header("origin", origin)
                .send()
                .await
                .unwrap();
            assert_eq!(res.status().as_u16(), 403, "{origin}");
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        // Same request from the app's own origin goes through.
        let body = reqwest::Client::new()
            .get(format!("http://{proxy}/mole/v1/data"))
            .header("origin", format!("http://127.0.0.1:{}", proxy.port()))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "secret123");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dns_rebound_host_is_rejected() {
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;
        let via = |name: &'static str| {
            reqwest::Client::builder()
                .resolve(name, proxy)
                .build()
                .unwrap()
        };

        // A foreign name resolving to the proxy (DNS rebinding): API and SPA.
        for path in ["/mole/v1/data", "/"] {
            let res = via("attacker.example")
                .get(format!("http://attacker.example:{}{path}", proxy.port()))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status().as_u16(), 403, "{path}");
        }
        // `localhost` is one of the proxy's own names.
        let body = via("localhost")
            .get(format!("http://localhost:{}/mole/v1/data", proxy.port()))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "secret123|GET|/mole/v1/data");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connection_nominated_headers_are_not_forwarded() {
        let handler = |headers: HeaderMap| async move {
            let seen = ["x-local-state", "x-end-to-end"]
                .map(|name| format!("{name}={}", headers.contains_key(name)))
                .join(",");
            (
                [
                    ("connection", "x-up-state"),
                    ("x-up-state", "1"),
                    ("x-kept", "1"),
                ],
                seen,
            )
        };
        let canopy = spawn_upstream(Router::new().fallback(any(handler))).await;
        let proxy = spawn_proxy(config(canopy, None), no_dist()).await;

        let res = reqwest::Client::new()
            .get(format!("http://{proxy}/mole/v1/data"))
            .header("connection", "x-local-state")
            .header("x-local-state", "1")
            .header("x-end-to-end", "1")
            .send()
            .await
            .unwrap();
        // Response side: the field upstream nominated is dropped, others kept.
        assert!(!res.headers().contains_key("x-up-state"));
        assert_eq!(res.headers()["x-kept"], "1");
        // Request side: same for the field the client nominated.
        assert_eq!(
            res.text().await.unwrap(),
            "x-local-state=false,x-end-to-end=true"
        );
    }
}
