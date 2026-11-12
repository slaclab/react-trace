# React Trace


React + Vite frontend for the Canopy / Trace plotting tool. Reads archive data from
Canopy's Mole module (`/mole/v1/...`), live PVs from Hare and formulas from the Formula
Engine, and posts e-log entries through Canopy's e-log module (`/elog/v1/apps/trace/...`).

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
`/mole`, `/hare`, `/formula-engine`, `/magpie` and `/vole` (HTTP and WebSocket), and Trace's
e-log app path (`/elog/v1/apps/trace/`), to `CANOPY_BASE_URL` and injects the `X-API-Key`
header, so the key never reaches the browser bundle. If `VITE_CANOPY_BASE_PATH` is set (for
example `/trace/api/canopy`), the dev server proxies that one prefix instead and strips it
before forwarding, like the container's nginx.

Trace uses two Canopy keys:

- `CANOPY_API_KEY` for Mole, Hare, the Formula Engine, Magpie and Vole:
  `read+write@mole+hare+formula-engine+magpie+vole`. Saving workspaces to the config store
  (Magpie) needs `write`. Canopy's `write` scope belongs to the key, not to a module, so this
  key can also write PVs through Hare.
- `CANOPY_ELOG_API_KEY` for the e-log module: `read+write@elog`.

The e-log key is separate so e-log access stays on Trace's own app path (see the production
notes below). In local dev, leave `CANOPY_ELOG_API_KEY` unset and the e-log proxy reuses
`CANOPY_API_KEY`, which covers both with a wildcard key like `dev:read+write@*`.

The proxy is [`canopyDevProxy`](https://github.com/slaclab/canopy-sdk-js/tree/main/packages/vite)
from `@slaclab/canopy-vite`. It refuses cross-origin browser requests, including pages on
another `localhost` port, so other sites open in your browser can't use the injected key.
To let a trusted page on another origin use it, add `allowedOrigins` to the options
`canopyProxyOptions()` returns in `vite.config.ts`.

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
reason. Logbooks preselected in the post dialog come from `DEFAULT_LOGBOOK_IDS`. Canopy
lists only the logbooks Trace's token can post to, so a default Trace can't post to isn't
preselected.

The dev server proxies only Trace's e-log app path. Other `/elog` paths aren't proxied. Under
`VITE_CANOPY_BASE_PATH` they go through that prefix with `CANOPY_API_KEY`, like every other
Canopy path in the container's nginx.

Migrating from the direct elog-plus setup: `DEFAULT_LOGBOOK_IDS` takes logbook **ids**,
not the logbook **names** `VITE_ELOG_DEFAULT_LOGBOOKS` took. Names match nothing, so
copying them over silently preselects no logbook. `ELOG_BASE_URL`, `ELOG_API_KEY` and
`VITE_ELOG_DEFAULT_LOGBOOKS` are no longer read.

In production the Trace container reverse-proxies `/trace/api/canopy/*` to the
in-cluster Canopy service and injects `X-API-Key`, so the browser bundle never
receives a key. `/trace/api/canopy/elog/v1/apps/trace/*` gets `CANOPY_ELOG_API_KEY`;
everything else (the Mole, Hare, Formula Engine, Magpie and Vole HTTP and WebSocket
routes, and any other e-log path) gets `CANOPY_API_KEY`. The e-log key stays on Trace's own app path
because Canopy doesn't bind keys to apps: on a wider path it could post as any app
configured in Canopy.
`CANOPY_ELOG_API_KEY` is optional: without it the container still starts, logs a
warning, and the post dialog shows Canopy's missing-key error. The e-log location
accepts request bodies up to 25 MiB so attachments (20 MiB by default in Canopy)
reach Canopy.

The header's bug and help buttons open this repo's GitHub issues and the public
docs site. A deployment can point them elsewhere with `VITE_BUG_REPORT_URL` and
`VITE_DOCS_URL` at build time; the image build reads them from the
`BUG_REPORT_URL` and `DOCS_URL` repository variables.

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
