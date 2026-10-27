# React Trace

[![dev deploy](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/slaclab/swapps-deployment-status/main/status/trace-dev.json)](https://github.com/slaclab/swapps-deployment)

React + Vite frontend for the Canopy / Trace plotting tool. Reads archive data from
Canopy's Mole module (`/mole/v1/...`), live PVs from Hare, formulas from Fox, and posts
e-log entries through Canopy's e-log module (`/elog/v1/apps/trace/...`).

## Local dev

### 1. Run the Canopy backend

In the Canopy repo, with at least one archiver configured and an API key registered:

```bash
cd ../Canopy
CANOPY_API_KEYS="dev:read+write@*" \
CANOPY_MOLE__DEFAULT_ARCHIVER=slac \
CANOPY_MOLE__ARCHIVERS__SLAC__TYPE=epics_archiver_appliance \
CANOPY_MOLE__ARCHIVERS__SLAC__URL=https://archiver.example.org \
uv run uvicorn canopy.main:app --reload --port 8000
```

### 2. Configure the frontend dev proxy

Copy `.env.example` to `.env` (gitignored). Set `CANOPY_API_KEY` to a token registered
in the backend's `CANOPY_API_KEYS` (e.g. `dev`).

```bash
cp .env.example .env
```

`CANOPY_API_KEY` is a server-side env var (no `VITE_` prefix). The Vite dev server proxies
`/mole`, `/hare`, `/fox` and Trace's e-log app path (`/elog/v1/apps/trace/`) to
`CANOPY_BASE_URL` and injects the `X-API-Key` header, so the key never reaches the browser
bundle.

Trace uses two Canopy keys:

- `CANOPY_API_KEY` for Mole, Hare and Fox. Read-only is enough: `read@mole+hare+fox`.
- `CANOPY_ELOG_API_KEY` for the e-log module: `read+write@elog`.

They are separate because Canopy's `write` scope belongs to the key, not to a module: giving
the main key `write` so it could post e-log entries would also let it write PVs through
Hare. In local dev, leave `CANOPY_ELOG_API_KEY` unset and the e-log proxy reuses
`CANOPY_API_KEY`, which covers both with a wildcard key like `dev:read+write@*`.

#### E-Log posting (optional)

Trace posts e-log entries through Canopy's e-log module, which holds Trace's
[elog-plus](https://github.com/slaclab/elog-plus) application token server-side, so neither
the token nor the Canopy key reaches the browser. Trace has nothing e-log specific to
configure; enable it on the Canopy backend with a provider and a token for the `trace` app:

```bash
CANOPY_ELOG__PROVIDER=elog_plus \
CANOPY_ELOG__ELOG_PLUS__BASE_URL=<elog-plus application-token URL> \
CANOPY_ELOG__APPS__TRACE__TOKEN=<elog-plus application token> \
CANOPY_ELOG__APPS__TRACE__DEFAULT_LOGBOOK_IDS='["<logbook id>"]' \
uv run uvicorn canopy.main:app --reload --port 8000
```

See Canopy's e-log module docs for the full settings. Trace reads
`/elog/v1/apps/trace/config` at startup: when Canopy reports e-log disabled, the
"Post to E-Log" toolbar button (and Ctrl/Cmd+E) hides and the browser console logs the
reason. Logbooks preselected in the post dialog come from `DEFAULT_LOGBOOK_IDS`.

In production the Trace container reverse-proxies `/trace/api/canopy/*` to the
in-cluster Canopy service and injects `X-API-Key`, so the browser bundle never
receives a key. `/trace/api/canopy/elog/v1/apps/trace/*` gets `CANOPY_ELOG_API_KEY`;
everything else (the Mole, Hare and Fox HTTP and WebSocket routes, and any other e-log
path) gets `CANOPY_API_KEY`. The e-log key stays on Trace's own app path because Canopy
doesn't bind keys to apps: on a wider path it could post as any app configured in Canopy.
`CANOPY_ELOG_API_KEY` is optional: without it the container still starts, logs a
warning, and the post dialog shows Canopy's missing-key error. The e-log location
accepts request bodies up to 25 MiB so attachments (20 MiB by default in Canopy)
reach Canopy.

### 3. Run the dev server

```bash
pnpm install
pnpm dev
```

## Scripts

```bash
pnpm dev           # vite dev server
pnpm build         # tsc -b && vite build
pnpm test          # vitest
pnpm lint          # eslint
pnpm format        # prettier --write
```
