# React Trace

React + Vite frontend for the Canopy / Trace plotting tool. Reads archive data from
Canopy's Mole module (`/mole/v1/...`), live PVs from Hare and formulas from the Formula
Engine, and posts e-log entries through Canopy's e-log module (`/elog/v1/apps/trace/...`).

## User docs

The **Docs** action in every tool opens the documentation site. Its source lives in
`docs/`. It is a [Zensical](https://zensical.org/) site, built with
`uv run zensical build --clean`, or previewed with `uv run zensical serve`:

- [The properties panel](docs/workbench.md): signals and cards, the plot-wide
  sections, the modified dot and reset, More, the chart source, and where
  actions live.
- [Waveform](docs/waveform.md): its lists, Snapshot → reference, Δ,
  persistence and averaging, the X-axis PV rule, its statistics.
- [Correlation](docs/correlation.md): its built-in metrics, variables, units.
- [Statistics](docs/statistics.md): the shared panel, the Metrics list,
  writing a metric, the function reference, the token grammar.
- [Drawing tools](docs/drawing-tools.md): time and axis gestures, range
  controls, drawing and measuring on a plot, keys, and how drawings are saved.

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
before forwarding, like the container's nginx. `VITE_CANOPY_BASE_PATH=..` is for a gateway
that serves the modules beside Trace: a page at `/x/y/trace/` then calls `/x/y/mole/...`.
The dev server treats `..` as unset.

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
`BUG_REPORT_URL` and `DOCS_URL` repository variables. A site's `config.json`
overrides both at runtime (below).

#### Site defaults (optional)

A deployment sets its own defaults without a rebuild: the header prefix and
links, the plot gestures, and what a new plot, curve or view opens with. Every
page reads `config.json` next to it (the image ships a neutral one at
`/usr/share/nginx/html/config.json`; mount your own over it) and Canopy's
site settings (`GET <Canopy base>/magpie/v1/settings/trace`), which win over
the file. `config.example.json` lists every key; `docs/site-defaults.md`
explains them. The file is served to every browser: no secrets in it. (The
desktop app's `src-tauri/config.json`, which holds keys, is a different file
and is never served.)

#### Channel catalog (optional)

Every PV field suggests names from two sources: Mole's archiver index, and a
channel catalog the host may serve beside it. The catalog is
`GET <Canopy base>/channels`, where `<Canopy base>` is the prefix the Mole,
Hare and Formula Engine routes sit under (`VITE_CANOPY_BASE_PATH` when set,
else the site root; `src/api/connection.ts`). It answers with a
JSON array of PV names (`string[]`) and a strong `ETag`; Trace fetches it once
per page and ranks it in the browser (`src/pvSearch/`). A `404` means the
deployment has no catalog, and suggestions then come from Mole alone. A
network error or a body that is not a string array is treated the same way.

### 3. Run the dev server

```bash
pnpm install
pnpm dev
```

## Scripts

```bash
pnpm dev           # vite dev server
pnpm build         # tsc -b && vite build, then the dist check
pnpm typecheck     # tsc -b
pnpm test          # chrome-literal guard, then vitest
pnpm test:e2e      # Playwright browser tests (e2e/*.e2e.ts) against a fresh build
pnpm lint          # eslint
pnpm format        # prettier --write
```

The browser tests need Chromium once per machine
(`pnpm exec playwright install chromium`). CI runs them with
`--grep-invert @perf`; the `@perf` specs time the main thread, so run them
alone on a quiet machine with `pnpm test:e2e --grep @perf`.

## Adding a tool to the workbench

Trace, Correlation and Waveform are the three tools on the workbench
(`src/workbench/`). The workbench owns the layout, the sidebar, the
properties panel and the actions bar. A tool supplies data and rules, and writes no layout
code. The worked example is the stub fourth tool in
`src/workbench/__fixtures__/stubTool.ts` (`createStubTool`, `stubSchema`).
The panel and layout tests run against it, and it has one of
everything described below.

### `ToolDefinition`

A tool hands `WorkbenchLayout` (from `src/workbench/index.ts`) a
`ToolDefinition` (`src/workbench/types.ts`), along with its `state`, `model`,
`ui`, a single writer `update(fn)` and its `capabilities`. The canvas goes in
as `children`. The definition has two halves:

- **`schema: ToolSchema`** is static. Build it once at module level, never
  per render. It holds the tool-level object and the `sections` and `items`
  by kind. Each object declares its field groups (`tabs`), and each group its
  fields (`FieldDef`, levels `L1` to `L3`; `L3` goes under More). The panel
  shows an item's groups as the titled blocks of its card, and the tool's as
  the plot-wide sections (ids and labels from `src/tools/vocabulary.ts`, each
  with a one-line `summary`). A section kind names its top-block `group`
  (Signals, Reference, …) and whether its fields sit under its cards or in
  Axes (`placement`). The tool's `code` group is the one chart-source link,
  printed by `src/tools/codeFragment.ts`. Fields read `ctx.target`, never
  the selection, and write only through `ctx.update`.
- **`binding: ToolBinding`** is rebuilt per render and read through a
  latest-ref. It holds `outline(state, model)` (the lists of the top block),
  `ops` (`add`, which is async and may resolve to an `AddRefusal`, plus
  `remove` and `move`), `moveRefusal(item, section)` (the one rule the Plot on
  select and card drags share) and optional `footer` actions.

See `src/tools/waveform/tool.ts` for a real tool. It builds its schema at
module level and its binding with `useWaveformDefinition`.

Canvas actions are registered from inside the canvas with `useCanvasActions`
(`src/workbench/useCanvasActions.ts`), and end with
`standardActions({ embedded, theme, bugUrl, docsUrl })`. Leave out an action
the deployment cannot support. Register a temporarily unusable one with
`disabled: '<reason>'`.

### Dot helpers

The workbench never knows a default. A field that has an automatic value
spreads a `Dot` (`modified(ctx)`, `reset(ctx)`) built by one of the helpers
in `src/tools/dotHelpers.ts`:

- `optionalPath`: the value is optional. It is modified when present, and
  reset writes `undefined`.
- `recordKey`: the value is an entry in a per-PV record. It is modified when
  the entry exists, and reset deletes it.
- `stampedValue`: the tool stamps an automatic value (a palette color, an
  axis slot). It is modified when the tool's rule rejects the stored value,
  and reset writes the object's own automatic value.

A field with no automatic rule uses no helper and shows no dot.

### Import allow-list

`src/workbench/**` must never reach into a tool. The ESLint rule
`workbench/import-allowlist` (`eslint.config.js`) allows only `react`,
`@carbon/*`, `@dnd-kit/*`, `react-resizable-panels`, `src/workbench/**` and
the shared PV field modules. Tests and `src/workbench/__fixtures__/` may also
use `vitest`, `@testing-library/*`, `src/tools/dotHelpers` and
`src/tools/codeFragment`. Tool code lives under `src/tools/<tool>/` and
imports the workbench, never the reverse. `pnpm lint` enforces this.

### Test ids are a contract

The `data-testid` values in `src/workbench/testids.ts` (`TESTIDS`, and
`inspectorTab(id)` → `inspector-tab-<id>`) are used by the sdk-js host probes
as well as the e2e specs, so they are a cross-repo contract.
`src/workbench/testids.test.ts` pins the set. A rename fails there first and
must be made in the probes too. Test ids are for chrome. Fields are reached by
their `#id`, and a control never has both.
