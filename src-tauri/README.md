# Trace desktop app (Tauri)

Ships the same SPA as the web deployment inside a Tauri v1 shell. In release
builds the native process runs an in-process reverse proxy on
`127.0.0.1:5178` that:

- serves the bundled frontend (`dist/`) with SPA deep-link fallback,
- forwards `/mole`, `/hare`, `/fox` (HTTP + WebSocket) to the configured Canopy
  backend, injecting `X-API-Key`,
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

`config.json` is gitignored because it can hold real keys; the build fails
without it because it is a declared bundle resource. Development runs
(`pnpm tauri:dev`) don't need it.

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

## Known limitations

- CI artifacts are unsigned (no macOS notarization, no Windows code signing);
  expect Gatekeeper/SmartScreen friction until signing is set up.
- One instance per machine (fixed port). A second instance shows the
  port-conflict dialog and exits.

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Unit tests cover path routing and config precedence; in-process end-to-end
tests run the real proxy against mock upstreams and assert header injection,
`/elog` prefix stripping, multipart pass-through, the 502-when-unconfigured
contract, SPA fallback, and WebSocket bridging including close-code
passthrough. The `test` job in `.github/workflows/tauri.yml` runs these on
pull requests.
