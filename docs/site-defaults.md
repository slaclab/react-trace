---
icon: lucide/settings
---

# Site defaults

Many of Trace's behaviour choices are only "which default ships": what the
wheel zooms, whether a new plot shows the crosshair, what the header says. A
deployment sets its own defaults without rebuilding or forking, for all three
tools (Trace, Correlation and Waveform) at once.

## Where they come from

Each page reads its defaults once, when it loads, from these sources. A later
source wins, key by key:

1. **Built-in defaults**: the values the product ships.
2. **`config.json` next to the app**: one file for all three pages, with a
   section per tool. It is read relative to the page, so it works under any
   base path.
3. **Canopy's site settings**: the document at
   `GET <Canopy base>/magpie/v1/settings/trace`, with the same shape as
   `config.json`. An administrator can change it at runtime, so it wins over
   the file. While it is unset, Canopy answers 404.
4. **The user's own choices**: their palette pick, their theme, and any
   setting they changed on a plot.
5. **What a file, link or host query says.**

`config.example.json` in the repository lists every key at its built-in value.
Copy only the keys you want to change into your `config.json`; a key you leave
out keeps following the built-in default when that changes in a later version.

The file is served to every browser: never put a secret in it.

### Loading

Both sources are fetched in parallel before the first render, each for at most
1.5 s:

- A missing file, or one that is not valid JSON, means the built-ins (an
  invalid file logs one warning).
- If Canopy is down, slow or answers 404, the page starts with the file's
  values.
- An answer that arrives after the timeout is ignored until the next page load,
  so defaults never change under a user mid-session.
- A single bad value is dropped with one console warning per source naming
  every dropped key. Values are checked like the tool's own fields: a site
  cannot set anything a user could not. Keys starting with `$` (such as
  `$comment`) are notes and are ignored.
- A `version` other than `1` makes the page ignore that source.

## What they change, and what they never change

Site defaults apply in two places:

- **Where a tool creates something**: Add plot, a new curve or formula, a
  fresh tab, a fresh Correlation or Waveform view.
- **App-level behaviour**: the mouse gestures, where the read-out sits, and the
  header with its links.

They never change what a saved file, a stored view or a link with settings
means. A Trace link with a `plot=` key, a `.trc.json` file or a config-store
view reads any key it leaves out at the product's fixed baseline. So does a
Correlation or Waveform link with any setting beyond its PVs. A new plot whose
values differ from that baseline writes them into its links and files, so they
open the same everywhere.

A link that names only PVs (and, for Trace, a range), such as "Open in Trace"
from another tool, carries no settings. It opens as a new plot or view, with
this site's defaults. If a plot's or view's settings are all back at the
baseline while this site's new ones differ from it, its links carry a marker
(an empty `plot={"v":1}` in Trace, `rail=1` in Waveform), so they still reopen
at the baseline values. Correlation's links always state their settings.

## Keys

### `header`

Trace's heading when it runs standalone (embedded, the host's tile bar names
the tool), and the links in every tool's help menu.

| Key            | Built in                       | Meaning                                                                          |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `prefix`       | `""`                           | Text before the product name, at most 40 characters.                             |
| `brand`        | `false`                        | The prefix and name in the shell's brand colour, as canopy-shell's `brandColor`. |
| `bugReportUrl` | the build's, else this project | The bug-report link (http or https). Overrides `VITE_BUG_REPORT_URL`.            |
| `docsUrl`      | the build's, else this project | The documentation link (http or https). Overrides `VITE_DOCS_URL`.               |

### `plot`: the mouse and the read-out

These apply to all three tools. Each tool's own `plot` section (`trace.plot`,
`correlation.plot`, `waveform.plot`) can override any of them.

| Key           | Values             | Built in                                     | Meaning                                                                                                                                                                                                                           |
| ------------- | ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wheel`       | `xy`, `x`          | Trace `x`; Correlation, Waveform `xy`        | `xy`: the wheel over the plot zooms X and every Y axis, and Alt+wheel the first Y axis alone. `x`: the wheel zooms X (time, in Trace) only, and Alt+wheel zooms X and every Y. Auto-scaled Y axes stay auto-scaled.               |
| `yAxisDrag`   | `stretch`, `pan`   | Trace `pan`; Correlation, Waveform `stretch` | What dragging a Y axis does. Shift+drag or Alt+drag does the other.                                                                                                                                                               |
| `doubleClick` | `reset`, `none`    | `reset`                                      | `reset`: a double-click in the plot resets every axis (Y axes to auto-scale; in Trace, time back to the range the plot was set to, such as Last 1 h). `none`: it does nothing. A double-click on an axis always resets that axis. |
| `tooltip`     | `docked`, `cursor` | `docked`                                     | Correlation and Waveform: the data read-out docked in a corner of the plot, or following the cursor. Trace's read-out is docked in this version.                                                                                  |

Over an axis, the wheel always zooms that axis alone, and Shift+wheel pans X.

### `trace.plot`: a new Trace plot

Used for Add plot, a fresh tab, and a link or host query without `plot=`.
Takes the `plot` keys above as well.

| Key                                | Built in  | Meaning                                                                                                                                                            |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `showCrosshair`                    | `false`   | Crosshair.                                                                                                                                                         |
| `dragMode`                         | `zoom`    | A left-drag in the plot: `zoom` (a zoom box) or `pan`.                                                                                                             |
| `showLegend`                       | `true`    | Legend.                                                                                                                                                            |
| `showXGridlines`, `showYGridlines` | `true`    | Gridlines.                                                                                                                                                         |
| `gridStyle`                        | `solid`   | `solid`, `dashed` or `dotted`.                                                                                                                                     |
| `gridOpacity`                      | `1`       | 0 to 1.                                                                                                                                                            |
| `tickFontSize`                     | `11`      | 6 to 48 px.                                                                                                                                                        |
| `refreshIntervalS`                 | `5`       | 1 to 60 s.                                                                                                                                                         |
| `palette`                          | `default` | A palette id. A user's own palette pick wins.                                                                                                                      |
| `timeRange`                        | `-1h`     | A relative range (`-30m`, `-1h`, `-1d`). A link's `range` wins.                                                                                                    |
| `archiver`                         | `null`    | The plot's default archiver; `null` is Canopy's default. Only the name's form is checked: a name Canopy does not know leaves every new plot showing "No archiver". |
| `showDrawingTools`                 | `true`    | The drawing rail.                                                                                                                                                  |

### `trace.trace`: a new Trace curve

| Key          | Built in | Meaning                                           |
| ------------ | -------- | ------------------------------------------------- |
| `lineWidth`  | `2`      | 0.5 to 20 px; formulas too.                       |
| `lineType`   | `step`   | `step` or `direct`; formulas are always `direct`. |
| `showSymbol` | `false`  | Markers at the samples; formulas too.             |

Live retention is not a site default: it follows the plot's span (at most
30 min) unless a user pins it on a curve.

### `correlation`: a fresh Correlation view

Used when the page opens with no state beyond its PVs (`x`, `y`, `trig`).

| Key            | Built in                                  | Meaning                                                                                           |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `lookback`     | `1h`                                      | 1m to 24h.                                                                                        |
| `dt`           | `1`                                       | The Timer trigger's period in seconds, at least 0.1; also where switching back to Timer starts.   |
| `metrics`      | the [defaults](correlation.md#statistics) | The statistics columns, in order, as the link's `m=` tokens (`-` first: listed but not a column). |
| `drawingTools` | `true`                                    | The drawing rail.                                                                                 |

### `waveform`: a fresh Waveform view

Used when the page opens with no state beyond its PVs (`pv`, `ref`, `xs`).

| Key            | Built in     | Meaning                                                        |
| -------------- | ------------ | -------------------------------------------------------------- |
| `rollS`        | `60`         | The Rolling mean window, 1 to 3600 s, when a user turns it on. |
| `metrics`      | the defaults | As in Correlation.                                             |
| `drawingTools` | `true`       | The drawing rail.                                              |

## Modified dots and Reset

For the keys a site sets, a field's modified dot compares against the site's
value, and its reset writes the site's value back: Refresh interval, Default
archiver, Mouse drag, Drawing tools and Palette in Trace. Reset metrics in
Correlation and Waveform returns to the site's metric list.

## Deploying

**Container image.** The image ships a neutral `config.json` (no settings)
at `/usr/share/nginx/html/config.json`. Mount your own over it:

```bash
docker run ... -v ./config.json:/usr/share/nginx/html/config.json:ro <image>
```

The file is served with `Cache-Control: no-cache`, so an edit takes effect on
each user's next page load.

**Desktop app.** The bundle serves the `dist/config.json` it was built with.
Edit `public/config.json` before building. This is not `src-tauri/config.json`,
which holds the Canopy URL and keys and is never served to the page.

**Development.** `pnpm dev` serves `public/config.json`. Edit it and reload
the page.
