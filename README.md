# React Trace

[![dev deploy](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/slaclab/swapps-deployment-status/main/status/trace-dev.json)](https://github.com/slaclab/swapps-deployment)

React + Vite frontend for the Canopy / Trace plotting tool. Reads archive data from
Canopy's Mole module (`/mole/v1/...`).

## Local dev

### 1. Run the Canopy backend

In the Canopy repo, with at least one archiver configured and an API key registered:

```bash
cd ../Canopy
CANOPY_API_KEYS="dev:read+write" \
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
`/mole`, `/hare`, `/fox`, `/magpie` and `/vole` (HTTP and WebSocket) to `CANOPY_BASE_URL` and
injects the `X-API-Key` header, so the key never reaches the browser bundle. The same key goes
to every one of these modules, so it must be scoped to all of them (`@*`) or to each one. If
`VITE_CANOPY_BASE_PATH` is set (for example `/trace/api/canopy`), the dev server proxies that
one prefix instead and strips it before forwarding, like the container's nginx.

The proxy is [`canopyDevProxy`](https://github.com/slaclab/canopy-sdk-js/tree/main/packages/vite)
from `@slaclab/canopy-vite`. It refuses cross-origin browser requests, including pages on
another `localhost` port, so other sites open in your browser can't use the injected key.
A trusted page on another origin needs to be listed in `allowedOrigins` in `vite.config.ts`.

#### E-Log posting (optional)

E-log goes through Canopy's e-log module. The dev server proxies only Trace's app path,
`/elog/v1/apps/trace/`, and injects `CANOPY_ELOG_API_KEY` there (`read+write@elog`), or
`CANOPY_API_KEY` when it is unset. The key stays on that path because Canopy doesn't bind
keys to apps: sent on every `/elog` path, it could post as any app configured in Canopy.
Other `/elog` paths aren't proxied. `VITE_ELOG_DEFAULT_LOGBOOKS` is an optional
comma-separated list of logbook names to preselect in the dialog.

In production the Trace container reverse-proxies `/trace/api/canopy/*` to the
in-cluster Canopy service and injects `X-API-Key`, so the browser bundle never
receives the key. This covers the Mole, Hare, and Fox HTTP and WebSocket routes.
The production reverse proxy must also own the `/elog` to elog-plus rewrite and
header injection when E-Log posting is enabled.

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
