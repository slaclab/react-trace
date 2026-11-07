# Trace desktop app (Tauri)

Ships the same SPA as the web deployment inside a Tauri v1 shell. In release
builds the native process runs an in-process reverse proxy on
`127.0.0.1:5178` that:

- serves the bundled frontend (`dist/`) with SPA deep-link fallback,
- forwards `/mole`, `/hare`, `/fox`, `/magpie`, `/vole` (HTTP + WebSocket) to
  the configured Canopy backend, injecting `X-API-Key` (the same prefixes as
  the Vite dev proxy in `vite.config.ts`),
- forwards `/elog` to the configured elog-plus backend with the `/elog` prefix
  stripped, injecting `x-vouch-idp-accesstoken` — the same contract the web
  deployment's reverse proxy owns (see the repo README's "E-Log posting"
  section).

The webview is created pointing at the proxy origin, so the frontend's relative
fetches and `window.location.host`-derived WebSocket URLs work unchanged, and
**no backend key ever reaches the JS bundle**. In `tauri dev` the Vite dev
server and its proxy handle all of this instead; the Rust proxy is release-only.

## Building

```bash
pnpm install
cp src-tauri/config.json.example src-tauri/config.json   # required bundle resource
pnpm tauri:build
```

`config.json` is gitignored because it can hold real keys; the release build
fails without it because it is a declared bundle resource. Development runs
(`pnpm tauri:dev`) and `cargo test` / `cargo check` / `cargo clippy` need
neither `config.json` nor `dist/`: `build.rs` drops both bundle resources
when the `custom-protocol` feature is off (only `tauri build` turns it on),
because only the release proxy reads them.

## Configuration

Each value resolves independently with this precedence (highest wins). Empty
strings count as unset at every level.

| Value           | CLI            | Env               | `config.json` | Default                 |
| --------------- | -------------- | ----------------- | ------------- | ----------------------- |
| Canopy base URL | `--canopy-url` | `CANOPY_BASE_URL` | `canopyUrl`   | `http://localhost:8000` |
| Canopy API key  | `--api-key`    | `CANOPY_API_KEY`  | `apiKey`      | empty (header omitted)  |
| E-log base URL  | `--elog-url`   | `ELOG_BASE_URL`   | `elogUrl`     | unset (e-log disabled)  |
| E-log token     | `--elog-key`   | `ELOG_API_KEY`    | `elogApiKey`  | empty (header omitted)  |

The env names match `.env.example`, so one `.env` serves both the web dev proxy
and the desktop app. Operators can repoint a packaged app at any backend with
env vars or CLI flags — no rebuild.

Leaving the e-log URL unset simply hides the "Post to E-Log" toolbar button
(the proxy answers 502 on `/elog`, which the frontend's availability probe
treats as "unavailable") — identical to the web app without `ELOG_BASE_URL`.

## Startup behavior

Release builds bind the proxy port **before** creating any window, and the
window opens directly on `http://127.0.0.1:5178/`. If the port is taken (most
likely a second running copy of Trace), a native error dialog explains the
problem and the app exits — there is no half-loaded window. The port is fixed
(not ephemeral) deliberately: the origin keys `localStorage`, so a stable port
preserves saved workspaces across launches.

## Security model / trust boundary

The proxy listens on loopback only, but **any local process can reach it** and
thereby make requests that carry the configured keys. This matches the trust
model of running the web stack's reverse proxy on the same host: the machine is
assumed to be a trusted operator console. Don't put a production write-token in
`config.json` on a shared machine.

Web pages in a browser on the same machine are a different matter, so the
proxy only answers requests addressed to its own origin:

- `Host` must be `127.0.0.1:5178` or `localhost:5178`. This blocks DNS
  rebinding, where another site's name resolves to 127.0.0.1.
- `Origin`, when the request has one, must be `http://127.0.0.1:5178` or
  `http://localhost:5178`. This blocks other sites from opening the live
  WebSocket streams (WebSockets aren't covered by CORS) and from cross-site
  form posts to `/elog`, which would otherwise carry the injected token.
  `Origin: null` is rejected too.

Anything else gets `403` before it reaches a backend. Requests without an
`Origin` (non-browser clients, same-origin GETs) are allowed; they're covered by
the local-process trust model above.

The proxy never follows backend redirects itself, because the HTTP client
would keep `X-API-Key` / `x-vouch-idp-accesstoken` on a redirect to another
host. A 3xx goes back to the webview. A `Location` on the configured backend
is rewritten to the matching proxy path (e-log paths get `/elog` back), so the
browser's follow-up comes through the proxy and gets the key again. A
`Location` on any other host is passed through unchanged, and the browser
follows it without the keys. Hop-by-hop headers, including any named in
`Connection`, are dropped in both directions.

## Known limitations

- CI artifacts are unsigned (no macOS notarization, no Windows code signing);
  expect Gatekeeper/SmartScreen friction until signing is set up.
- One instance per machine (fixed port). A second instance shows the
  port-conflict dialog and exits.

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

No `config.json` or `dist/` is needed. Unit tests cover path routing, config
precedence (against a fixed environment, so your own `CANOPY_BASE_URL` etc.
don't affect them), the origin check, hop-by-hop stripping and `Location`
rewriting. In-process end-to-end tests run the real proxy against mock
upstreams and assert header injection, `/elog` prefix stripping, multipart
pass-through, the 502-when-unconfigured contract, SPA fallback, WebSocket
bridging including close-code passthrough, `403` for foreign origins and
rebound host names (HTTP and WebSocket), and that redirects aren't followed.
The `test` job in `.github/workflows/tauri.yml` runs these on pull requests.
