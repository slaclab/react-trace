# React Trace

[![dev deploy](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/slaclab/swapps-deployment-status/main/status/trace-dev.json)](https://github.com/slaclab/swapps-deployment)

React + Vite frontend for the Canopy / Trace plotting tool. Reads archive data from
Canopy's Mole module (`/mole/v1/...`).

## Registry access

The shared Canopy packages (`@slaclab/canopy-*`) are published to GitHub Packages, not
npm. The committed `.npmrc` points the `@slaclab` scope at `https://npm.pkg.github.com`.
That registry requires authentication even to read, so once the app depends on an
`@slaclab` package, `pnpm install` needs a token:

1. Create a classic personal access token with the `read:packages` scope.
2. Add it to your user-level `~/.npmrc`, never to the repo's `.npmrc`:

   ```
   //npm.pkg.github.com/:_authToken=<PAT>
   ```

CI authenticates with the workflow's `GITHUB_TOKEN` (`packages: read`). That only works
if each `@slaclab/canopy-*` package grants this repository read access under
**Package settings → Manage Actions access**. See the
[canopy-sdk-js install notes](https://github.com/slaclab/canopy-sdk-js#installing-consumers).

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
`/mole/*` to `CANOPY_BASE_URL` and injects the `X-API-Key` header, so the key never reaches
the browser bundle.

#### E-Log posting (optional)

Set `ELOG_BASE_URL` to an [elog-plus](https://github.com/eed-web-application/elog-plus)
instance and `ELOG_API_KEY` to an application token. The dev server proxies `/elog/*` to
that service (stripping the `/elog` prefix) and injects the `x-vouch-idp-accesstoken` header,
so the token never reaches the browser bundle. Leave `ELOG_BASE_URL` unset to disable the
feature (the "Post to E-Log" toolbar button hides). `VITE_ELOG_DEFAULT_LOGBOOKS` is an
optional comma-separated list of logbook names to preselect in the dialog.

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
