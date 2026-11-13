//! In-process reverse proxy for the desktop app.
//!
//! Serves the bundled SPA (`dist/`) at `/` and forwards the Canopy path
//! prefixes the frontend uses (`/mole`, `/hare`, `/formula-engine`, `/magpie`, `/vole`)
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
use tower_http::set_header::SetResponseHeaderLayer;

use crate::config::CanopyConfig;

/// Path prefixes that get forwarded to Canopy (everything else is static SPA).
/// Keep in sync with the Canopy entries in vite.config.ts `server.proxy`: a
/// prefix missing here falls through to the SPA and gets index.html back.
const API_PREFIXES: [&str; 5] = ["/mole", "/hare", "/formula-engine", "/magpie", "/vole"];

/// E-log requests. Only those under [`ELOG_APP_PREFIX`] are forwarded.
const ELOG_PREFIX: &str = "/elog";

/// Trace's app in Canopy's e-log module, the only e-log path forwarded (see
/// [`route`]). Keep in sync with `elogAppPath` in vite.config.ts.
const ELOG_APP_PREFIX: &str = "/elog/v1/apps/trace/";

fn has_prefix(path: &str, prefix: &str) -> bool {
    path == prefix || (path.starts_with(prefix) && path.as_bytes()[prefix.len()] == b'/')
}

fn is_api_path(path: &str) -> bool {
    API_PREFIXES.iter().any(|p| has_prefix(path, p))
}

fn is_elog_path(path: &str) -> bool {
    has_prefix(path, ELOG_PREFIX)
}

fn is_elog_app_path(path: &str) -> bool {
    path.starts_with(ELOG_APP_PREFIX)
}

/// `target`'s path below `base`'s own path, when `target` is on `base`'s origin
/// and under its path. Only the path counts, never the query, and `target`
/// comes from URL parsing, so `..` is already resolved and can't climb above a
/// base path.
fn path_below_base<'t>(target: &'t reqwest::Url, base: &str) -> Option<&'t str> {
    let base = reqwest::Url::parse(base).ok()?;
    if target.origin() != base.origin() {
        return None;
    }
    let rest = target
        .path()
        .strip_prefix(base.path().trim_end_matches('/'))?;
    (rest.is_empty() || rest.starts_with('/')).then_some(rest)
}

/// Where and how to forward one HTTP request.
struct Forward<'a> {
    /// Upstream base URL, no trailing slash. The request path is forwarded
    /// unchanged below it.
    base: &'a str,
    /// Which paths may be forwarded, checked on the path as it reaches
    /// upstream: below `base`'s own path, with dot segments resolved. A raw
    /// `/mole/../elog/...` resolves to `/elog/...`, so routing on the raw path
    /// alone isn't enough. Anything else gets a 404 and is not forwarded.
    allowed: fn(&str) -> bool,
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

/// Content-Security-Policy for every response. Tauri's `tauri.security.csp`
/// doesn't reach this app's pages: Tauri v1 adds it only to pages it serves
/// over its own `tauri://` protocol, and the webview loads this proxy's origin
/// instead, so the proxy sends the policy itself.
///
/// Everything is limited to this origin, except:
/// - `connect-src` also lists the WebSocket origins, because older WebKit
///   doesn't match `ws:` under `'self'`. Both [`LOCAL_HOSTS`] names are listed.
/// - `style-src 'unsafe-inline'`: ECharts tooltips are HTML strings with
///   `style` attributes, and Carbon sets inline styles.
/// - `img-src data: blob:`: Carbon's CSS has `data:` SVG icons, and plot
///   captures (the e-log preview, image export) are `data:`/`blob:` URLs.
/// - `font-src`: `@carbon/styles` loads IBM Plex from IBM's CDN.
///
/// Scripts are `'self'` only (the Vite build has no inline scripts and
/// nothing uses `eval`), and `frame-ancestors 'none'` stops any other page,
/// including one in a local browser, from framing the app.
fn content_security_policy(port: u16) -> String {
    let ws_origins = LOCAL_HOSTS
        .map(|host| format!("ws://{host}:{port}"))
        .join(" ");
    format!(
        "default-src 'self'; \
         script-src 'self'; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; \
         font-src 'self' https://1.www.s81c.com; \
         connect-src 'self' {ws_origins}; \
         object-src 'none'; \
         base-uri 'self'; \
         form-action 'self'; \
         frame-ancestors 'none'"
    )
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
    // X-API-Key when a redirect changes host. The 3xx goes back to the webview
    // instead, with same-upstream locations mapped back onto the proxy (see
    // `rewrite_location`).
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(std::io::Error::other)?;

    let state = ProxyState {
        config: Arc::new(config),
        http,
        bound,
    };

    let csp = HeaderValue::from_str(&content_security_policy(bound.port()))
        .expect("CSP is a valid header value");

    let app = Router::new()
        // API prefixes are matched inside the handler; catch-all sends
        // everything here and we branch on the path.
        .fallback(any(route))
        .with_state((state, Arc::new(static_service)))
        // On every response, not just the SPA's: injected script could open
        // any same-origin URL in a window or frame, and a page there without
        // the policy would let it get around it.
        .layer(SetResponseHeaderLayer::overriding(
            http::header::CONTENT_SECURITY_POLICY,
            csp,
        ));

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

    // E-log: Canopy's e-log module, which holds Trace's elog-plus token
    // server-side and says through /config whether posting is on. Forwarded to
    // Canopy unchanged, with the e-log key. As in the Vite dev proxy, only
    // Trace's own app path goes through: Canopy doesn't bind keys to apps
    // ({app} only picks the server-side token), so a wider prefix would let the
    // key post as any configured app.
    if is_elog_path(&path) {
        let forward = Forward {
            base: &state.config.canopy_url,
            allowed: is_elog_app_path,
            header_name: HeaderName::from_static("x-api-key"),
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
            allowed: is_api_path,
            header_name: HeaderName::from_static("x-api-key"),
            header_value: &state.config.api_key,
        };
        return proxy_http(&state, method, uri, headers, body, forward).await;
    }

    // Static SPA asset. tower-http's ServeDir wants a Request; rebuild one with
    // the original headers, so If-Modified-Since gets a 304 and Range a 206.
    let mut req = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("static request");
    *req.headers_mut() = headers;
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

/// Forward an HTTP request upstream per `forward` (target base, allowed paths,
/// auth header), streaming the request body up and the response body back.
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
    // Parsed once, and this URL is what gets sent: parsing resolves dot
    // segments (`..`, `%2e%2e`), so the path checked below is the one upstream
    // sees.
    let Ok(target) = reqwest::Url::parse(&format!("{}{}", forward.base, path_and_query)) else {
        return (StatusCode::BAD_REQUEST, "bad request path").into_response();
    };
    if !path_below_base(&target, forward.base).is_some_and(forward.allowed) {
        tracing::warn!(
            path = target.path(),
            "request outside the allowed paths not forwarded"
        );
        return (StatusCode::NOT_FOUND, "not forwarded").into_response();
    }

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

    let mut builder = state.http.request(reqwest_method, target.clone());
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
                        .and_then(|loc| rewrite_location(loc, &target, forward.base));
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
            tracing::warn!(%err, %target, "upstream request failed");
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
/// is returned (the part below `base`): the browser's follow-up then comes
/// through the proxy, which re-injects the key. Anything else (another host, port or scheme, or a path
/// outside the base) returns `None` and is passed through unchanged; the
/// browser follows it without any of the proxy's credentials.
fn rewrite_location(location: &str, target: &reqwest::Url, base: &str) -> Option<String> {
    let base = reqwest::Url::parse(base).ok()?;
    let resolved = target.join(location).ok()?;
    if resolved.origin() != base.origin() {
        return None;
    }
    let rest = resolved
        .path()
        .strip_prefix(base.path().trim_end_matches('/'))?;
    if !(rest.is_empty() || rest.starts_with('/')) {
        return None;
    }
    let mut out = rest.to_string();
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
        assert!(is_api_path("/formula-engine/v1/validate"));
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
            .filter(|key| key.starts_with('/'))
            .collect();
        vite_prefixes.sort_unstable();
        let mut ours = API_PREFIXES.to_vec();
        ours.sort_unstable();
        assert!(
            !vite_prefixes.is_empty(),
            "no proxy keys found in vite.config.ts"
        );
        assert_eq!(ours, vite_prefixes);
        // The e-log entry is keyed by this constant rather than a literal.
        assert!(
            vite.contains(&format!("const elogAppPath = '{ELOG_APP_PREFIX}';")),
            "elogAppPath in vite.config.ts differs from ELOG_APP_PREFIX"
        );
    }

    #[test]
    fn elog_app_path_check_resolves_dot_segments() {
        let under = |base: &str, path: &str| {
            let target = reqwest::Url::parse(&format!("{base}{path}")).unwrap();
            path_below_base(&target, base).is_some_and(is_elog_app_path)
        };
        let base = "http://canopy:8000";
        assert!(under(base, "/elog/v1/apps/trace/entries?x=1"));
        assert!(under(base, "/elog/v1/apps/trace/a/../entries"));
        for path in [
            "/elog/v1/apps/trace/../other/entries",
            "/elog/v1/apps/trace/%2e%2e/other/entries",
            "/elog/v1/apps/trace/.%2E/other/entries",
            "/elog/v1/apps/trace/..\\other/entries",
            "/elog/v1/apps/trace2/entries",
            "/elog/v1/apps/trace",
            "/elog/v1/logbooks",
            "/other?/elog/v1/apps/trace/",
        ] {
            assert!(!under(base, path), "{path}");
        }
        // Below a base path, and `..` can't climb above it.
        let based = "http://canopy:8000/api";
        assert!(under(based, "/elog/v1/apps/trace/entries"));
        assert!(!under(based, "/../elog/v1/apps/trace/entries"));
        // A sibling of the base path isn't below it.
        let target = reqwest::Url::parse("http://canopy:8000/apix/elog/v1/apps/trace/x").unwrap();
        assert_eq!(path_below_base(&target, based), None);
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

    fn config(canopy: SocketAddr) -> CanopyConfig {
        CanopyConfig {
            canopy_url: format!("http://{canopy}"),
            api_key: "secret123".into(),
            elog_key: "elogkey".into(),
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
        let proxy = spawn_proxy(config(upstream), no_dist()).await;

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
        let proxy = spawn_proxy(config(upstream), no_dist()).await;

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
    async fn forwards_elog_app_path_to_canopy_with_elog_key() {
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

        let body = reqwest::get(format!(
            "http://{proxy}/elog/v1/apps/trace/logbooks?ids=a,b"
        ))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
        // The e-log key, not the Canopy key; path and query unchanged.
        assert_eq!(body, "elogkey|GET|/elog/v1/apps/trace/logbooks?ids=a,b");
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
        let canopy =
            spawn_upstream(Router::new().route("/elog/v1/apps/trace/attachments", post(handler)))
                .await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

        // Hand-rolled multipart (a metadata part + one fake PNG part), the
        // shape of an attachment upload.
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
            .post(format!("http://{proxy}/elog/v1/apps/trace/attachments"))
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
        let canopy =
            spawn_upstream(Router::new().route("/elog/v1/apps/trace/attachments", post(handler)))
                .await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

        let chunks = futures_util::stream::once(async { Ok::<_, std::io::Error>("first,") }).chain(
            futures_util::stream::once(async move {
                first_seen.notified().await;
                Ok("second")
            }),
        );
        let send = reqwest::Client::new()
            .post(format!("http://{proxy}/elog/v1/apps/trace/attachments"))
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
        let proxy = spawn_proxy(config(canopy), no_dist()).await;
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
    async fn elog_paths_outside_trace_app_are_not_forwarded() {
        let hits = Arc::new(AtomicUsize::new(0));
        let canopy = spawn_upstream(counting_router(hits.clone())).await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;
        let status = |target: &'static str| async move {
            tokio::task::spawn_blocking(move || raw_get_status(proxy, target))
                .await
                .unwrap()
        };

        // Control: Trace's app path, sent the same way, is forwarded.
        assert_eq!(status("/elog/v1/apps/trace/config").await, 200);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        for target in [
            "/elog/v1/apps/trace/../other/entries",
            "/elog/v1/apps/trace/%2e%2e/other/entries",
            "/elog/v1/apps/trace/.%2E/other/entries",
            "/elog/v1/apps/trace2/entries",
            "/elog/v1/logbooks",
            "/elog/../mole/v1/data",
        ] {
            assert_eq!(status(target).await, 404, "{target}");
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "only the control was forwarded"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn canopy_paths_resolving_outside_the_modules_are_not_forwarded() {
        let hits = Arc::new(AtomicUsize::new(0));
        let canopy = spawn_upstream(counting_router(hits.clone())).await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;
        let status = |target: &'static str| async move {
            tokio::task::spawn_blocking(move || raw_get_status(proxy, target))
                .await
                .unwrap()
        };

        // Controls: a module path, and one whose `..` stays inside the module.
        assert_eq!(status("/mole/v1/data").await, 200);
        assert_eq!(status("/mole/v1/x/../data").await, 200);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        // Resolved, these leave the Canopy modules: another app's e-log path
        // (with the Canopy key), Trace's own (with the wrong key), the root.
        for target in [
            "/mole/../elog/v1/apps/other/entries",
            "/hare/%2e%2e/elog/v1/apps/trace/entries",
            "/vole/../",
        ] {
            assert_eq!(status(target).await, 404, "{target}");
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "only the controls were forwarded"
        );
    }

    /// `GET target` sent byte for byte, so `..` and `%2e` reach the proxy
    /// unresolved (an HTTP client would resolve them first). Returns the status.
    fn raw_get_status(proxy: SocketAddr, target: &str) -> u16 {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(proxy).unwrap();
        write!(
            stream,
            "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            proxy.port()
        )
        .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let response = String::from_utf8_lossy(&response);
        response
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("no status line in {response:?}"))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn serves_spa_with_deep_link_fallback() {
        let dist =
            std::env::temp_dir().join(format!("trace-proxy-test-dist-{}", std::process::id()));
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<html>trace-spa</html>").unwrap();
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy), dist).await;

        let root = reqwest::get(format!("http://{proxy}/")).await.unwrap();
        assert_eq!(root.status().as_u16(), 200);
        assert!(root.text().await.unwrap().contains("trace-spa"));
        // Unknown deep link falls back to index.html (SPA routing).
        let deep = reqwest::get(format!("http://{proxy}/some/deep/link"))
            .await
            .unwrap();
        assert!(deep.text().await.unwrap().contains("trace-spa"));
    }

    /// The static path keeps the request's headers: ServeDir answers a
    /// conditional reload with 304 and a Range request with 206.
    #[tokio::test(flavor = "multi_thread")]
    async fn static_assets_honour_conditional_and_range_requests() {
        let dist =
            std::env::temp_dir().join(format!("trace-proxy-test-cond-{}", std::process::id()));
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::write(dist.join("index.html"), "<html>trace-spa</html>").unwrap();
        std::fs::write(dist.join("assets/app.js"), "0123456789").unwrap();
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy), dist).await;
        let url = format!("http://{proxy}/assets/app.js");
        let client = reqwest::Client::new();

        let first = client.get(&url).send().await.unwrap();
        assert_eq!(first.status().as_u16(), 200);
        let last_modified = first
            .headers()
            .get(http::header::LAST_MODIFIED)
            .expect("Last-Modified on a static asset")
            .clone();

        let reload = client
            .get(&url)
            .header(http::header::IF_MODIFIED_SINCE, last_modified)
            .send()
            .await
            .unwrap();
        assert_eq!(reload.status().as_u16(), 304);

        let range = client
            .get(&url)
            .header(http::header::RANGE, "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(range.status().as_u16(), 206);
        assert_eq!(range.text().await.unwrap(), "2345");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_response_carries_the_csp() {
        let dist =
            std::env::temp_dir().join(format!("trace-proxy-test-csp-{}", std::process::id()));
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<html>trace-spa</html>").unwrap();
        // An upstream policy is replaced, not merged.
        let upstream_csp = || async { ([("content-security-policy", "upstream")], "data") };
        let canopy = spawn_upstream(Router::new().fallback(any(upstream_csp))).await;
        let proxy = spawn_proxy(config(canopy), dist).await;
        let port = proxy.port();
        let client = reqwest::Client::new();

        let responses = [
            ("SPA", client.get(format!("http://{proxy}/"))),
            (
                "SPA deep link",
                client.get(format!("http://{proxy}/some/deep/link")),
            ),
            ("Canopy", client.get(format!("http://{proxy}/mole/v1/data"))),
            (
                "e-log 404",
                client.get(format!("http://{proxy}/elog/v1/logbooks")),
            ),
            (
                "foreign-origin 403",
                client
                    .get(format!("http://{proxy}/mole/v1/data"))
                    .header("origin", "https://attacker.example"),
            ),
        ];
        for (what, req) in responses {
            let res = req.send().await.unwrap();
            let csp: Vec<_> = res
                .headers()
                .get_all(http::header::CONTENT_SECURITY_POLICY)
                .iter()
                .map(|v| v.to_str().unwrap().to_string())
                .collect();
            assert_eq!(csp, [content_security_policy(port)], "{what}");
        }

        // The page may connect only to this proxy, over HTTP and WebSocket,
        // and runs only its own scripts.
        let csp = content_security_policy(port);
        for directive in [
            "default-src 'self'".to_string(),
            "script-src 'self'".to_string(),
            format!("connect-src 'self' ws://127.0.0.1:{port} ws://localhost:{port}"),
            "frame-ancestors 'none'".to_string(),
        ] {
            assert!(
                csp.split("; ").any(|d| d == directive),
                "missing `{directive}` in {csp}"
            );
        }
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
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

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
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

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
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

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
    async fn elog_redirect_comes_back_through_the_proxy() {
        let redirect = || async { (StatusCode::FOUND, [(http::header::LOCATION, "new")]) };
        let canopy = spawn_upstream(
            echo_router("x-api-key").route("/elog/v1/apps/trace/old", get(redirect)),
        )
        .await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

        let res = no_follow()
            .get(format!("http://{proxy}/elog/v1/apps/trace/old"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            res.headers()[http::header::LOCATION],
            "/elog/v1/apps/trace/new"
        );
        // Followed, the second hop gets the e-log key again.
        let body = reqwest::get(format!("http://{proxy}/elog/v1/apps/trace/old"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "elogkey|GET|/elog/v1/apps/trace/new");
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
        let proxy = spawn_proxy(config(canopy), no_dist()).await;
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
        let canopy = spawn_upstream(counting_router(hits.clone())).await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

        // Cross-site form POST to the e-log (would carry the injected key).
        let res = reqwest::Client::new()
            .post(format!("http://{proxy}/elog/v1/apps/trace/entries"))
            .header("origin", "https://attacker.example")
            .header("content-type", "multipart/form-data; boundary=x")
            .body("--x--\r\n")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 403);
        // Cross-origin reads of Canopy data: another site, an opaque origin,
        // and near misses on the proxy's own origin (wrong host, scheme or
        // port, or its authority as a prefix of another host).
        let port = proxy.port();
        for origin in [
            "https://attacker.example".to_string(),
            "null".to_string(),
            format!("http://attacker.example:{port}"),
            format!("https://127.0.0.1:{port}"),
            format!("http://127.0.0.1:{}", port.wrapping_add(1)),
            format!("http://127.0.0.1:{port}.attacker.example"),
        ] {
            let res = reqwest::Client::new()
                .get(format!("http://{proxy}/mole/v1/data"))
                .header("origin", &origin)
                .send()
                .await
                .unwrap();
            assert_eq!(res.status().as_u16(), 403, "{origin}");
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        // Same request from the app's own origin (either host name) goes
        // through.
        for host in LOCAL_HOSTS {
            let body = reqwest::Client::new()
                .get(format!("http://{proxy}/mole/v1/data"))
                .header("origin", format!("http://{host}:{port}"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert_eq!(body, "secret123", "{host}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dns_rebound_host_is_rejected() {
        let canopy = spawn_upstream(echo_router("x-api-key")).await;
        let proxy = spawn_proxy(config(canopy), no_dist()).await;
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
        // A local name on the wrong port, or with no port, isn't this proxy.
        for host in [
            format!("127.0.0.1:{}", proxy.port().wrapping_add(1)),
            "127.0.0.1".to_string(),
        ] {
            let res = reqwest::Client::new()
                .get(format!("http://{proxy}/mole/v1/data"))
                .header("host", &host)
                .send()
                .await
                .unwrap();
            assert_eq!(res.status().as_u16(), 403, "{host}");
        }
        // `localhost` is one of the proxy's own names, with or without the
        // matching Origin.
        let own = format!("http://localhost:{}", proxy.port());
        for origin in [None, Some(own.as_str())] {
            let mut req = via("localhost").get(format!("{own}/mole/v1/data"));
            if let Some(origin) = origin {
                req = req.header("origin", origin);
            }
            let body = req.send().await.unwrap().text().await.unwrap();
            assert_eq!(body, "secret123|GET|/mole/v1/data", "{origin:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connection_nominated_headers_are_not_forwarded() {
        let handler = |headers: HeaderMap| async move {
            let seen = [
                "x-local-state",
                "x-other",
                "keep-alive",
                "proxy-connection",
                "x-end-to-end",
            ]
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
        let proxy = spawn_proxy(config(canopy), no_dist()).await;

        // Two Connection values, with mixed case, padding and empty tokens.
        let res = reqwest::Client::new()
            .get(format!("http://{proxy}/mole/v1/data"))
            .header("connection", "keep-alive, X-Local-State")
            .header("connection", " x-other ,,")
            .header("x-local-state", "1")
            .header("x-other", "1")
            .header("keep-alive", "timeout=5")
            .header("proxy-connection", "keep-alive")
            .header("x-end-to-end", "1")
            .send()
            .await
            .unwrap();
        // Response side: the field upstream nominated is dropped, others kept.
        assert!(!res.headers().contains_key("x-up-state"));
        assert_eq!(res.headers()["x-kept"], "1");
        // Request side: nominated fields and the fixed hop-by-hop list are
        // dropped, end-to-end fields kept.
        assert_eq!(
            res.text().await.unwrap(),
            "x-local-state=false,x-other=false,keep-alive=false,\
             proxy-connection=false,x-end-to-end=true"
        );
    }

    /// Upstream that redirects to whatever `x-test-location` names.
    fn redirect_router() -> Router {
        Router::new().fallback(any(|headers: HeaderMap| async move {
            let to = headers["x-test-location"].clone();
            (StatusCode::FOUND, [(http::header::LOCATION, to)])
        }))
    }

    /// The `Location` the proxy hands back when upstream redirects `path` to
    /// `location`.
    async fn location_via_proxy(proxy: SocketAddr, path: &str, location: &str) -> String {
        let res = no_follow()
            .get(format!("http://{proxy}{path}"))
            .header("x-test-location", location)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 302, "{location}");
        res.headers()[http::header::LOCATION]
            .to_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn canopy_redirect_locations_map_onto_proxy() {
        let upstream = spawn_upstream(redirect_router()).await;
        // A host name rather than an IP, so host case can be checked.
        let base = format!("http://localhost:{}", upstream.port());
        let other_port = format!("http://localhost:{}", upstream.port().wrapping_add(1));
        let cfg = CanopyConfig {
            canopy_url: base.clone(),
            ..config(upstream)
        };
        let proxy = spawn_proxy(cfg, no_dist()).await;
        let path = "/mole/v1/data/?n=1";

        // On the upstream: absolute (host case doesn't matter), path-absolute
        // and relative forms all come back as proxy paths, keeping query and
        // fragment.
        let upper = base.replace("localhost", "LOCALHOST");
        for (location, expected) in [
            (format!("{base}/mole/v1/data?n=1"), "/mole/v1/data?n=1"),
            (format!("{upper}/mole/x"), "/mole/x"),
            ("/mole/v1/data?n=1".to_string(), "/mole/v1/data?n=1"),
            ("../other".to_string(), "/mole/v1/other"),
            (base.clone(), "/"),
            (format!("{base}/x#frag"), "/x#frag"),
        ] {
            assert_eq!(location_via_proxy(proxy, path, &location).await, expected);
        }
        // Another host, scheme or port: passed through unchanged.
        for location in [
            "http://attacker.example/steal".to_string(),
            "//attacker.example/steal".to_string(),
            base.replace("http:", "https:") + "/mole/x",
            format!("{other_port}/mole/x"),
        ] {
            assert_eq!(location_via_proxy(proxy, path, &location).await, location);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn redirect_locations_under_a_base_path_map_back() {
        let upstream = spawn_upstream(redirect_router()).await;
        // A Canopy base with a path: only locations under it map back.
        let cfg = CanopyConfig {
            canopy_url: format!("http://{upstream}/api"),
            ..config(upstream)
        };
        let proxy = spawn_proxy(cfg, no_dist()).await;
        let path = "/elog/v1/apps/trace/entries";

        let base_root = format!("http://{upstream}/api");
        for (location, expected) in [
            (
                "/api/elog/v1/apps/trace/entries/42",
                "/elog/v1/apps/trace/entries/42",
            ),
            (base_root.as_str(), "/"),
            // Outside the base path: passed through unchanged.
            ("/apix/v1", "/apix/v1"),
            ("/login", "/login"),
        ] {
            assert_eq!(location_via_proxy(proxy, path, location).await, expected);
        }
    }
}
