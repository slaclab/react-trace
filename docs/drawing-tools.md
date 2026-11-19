---
icon: lucide/pencil-ruler
---

# Drawing tools

Trace lets you move through time and scale the axes straight on the plot, and
draw on it: horizontal and vertical lines, time ranges, trend lines, boxes,
notes and measurements. Drawings sit in data coordinates, so they stay on the
value and time they mark while you zoom, pan or follow live data. They are
listed under **Drawings** in the properties panel, edited in their cards, undone with
⌘Z / Ctrl+Z, and saved with the plot.

Every plot behaves the same way wherever it is shown: as a tab, as a cell of
the grid, full screen, or in a detached window.

The same drawing tools work in [Correlation](correlation.md) and
[Waveform](waveform.md); see [Drawing in Correlation and
Waveform](#other-plots) for what differs there.

## Moving through time { #navigation }

The plot shows a _view window_ of time. Any gesture that moves it stops the
plot from following live data; **Now** (below) turns following back on.

- **Wheel** over the plot zooms time around the cursor; auto-scaled Y axes
  refit to what is visible. **Alt + wheel** zooms time and every Y axis.
- **Shift + wheel**, or a mostly sideways trackpad scroll, pans time; so do
  the **←** and **→** keys while the plot has focus.
- **Drag** the plot with the left button to draw a zoom box; the plot zooms to
  it when you let go, and a thin box zooms only time or only the Y axes. With
  the rail's drag toggle set to pan, the drag pans time instead: every Y axis
  you have scaled by hand moves with it, auto-scaled axes refit to what is
  visible.
- **Double-click** the plot returns time to the plot's range (for example the
  last hour) and turns auto-scale back on for every Y axis.
- **Wheel** over the time axis labels zooms time around the cursor.
- **Drag** along the time axis labels stretches time with the right edge
  held still: drag right to zoom in, left to zoom out. When the right edge is
  at now, the plot keeps following live data with the new span.
- **Double-click** the time axis labels returns time to the plot's range.
- **Right-click** the time axis labels for a **Time range** menu: _All_ and
  every preset of the Time range field.

The plot's tab bar (and the header of a grid cell, the full-screen view and a
detached window) carries the range controls:

- **1h**, **6h**, **24h** pick the last hour, six hours or day.
- **All** shows from the earliest loaded sample to now.
- **Go to** takes a date and time and centers a window of the current span on
  it.
- **Now** follows live data again with the last relative span you used, or
  the last hour if there was none.

## Scaling the Y axes { #axes }

- **Drag** a Y axis up or down to move that axis alone. **Shift + drag** (or
  **Alt + drag**) zooms it instead: up to zoom in about its center, down to
  zoom out. Either way the axis stops auto-scaling.
- **Wheel** over a Y axis zooms it around the value under the cursor.
- **Alt + wheel** over the plot zooms time and every Y axis around the
  cursor.
- **Double-click** a Y axis, or click the **A** badge that appears above a
  hand-scaled axis, to turn auto-scale back on.
- **Right-click** a Y axis for its options menu: _Auto-scale_, _Logarithmic_,
  _Reset scale_. _Invert_ is listed but not available yet.

Right-click inside the plot for the point's menu: _Add horizontal line here_,
_Add vertical line here_, _Add note here_ (which opens the new note's text
box), _Reset zoom_ (the time range and every hand-scaled axis back) and the
copy and share actions; see [Right-click menus](workbench.md#right-click).
Right-click a drawing instead for the drawing's own menu (see
[Editing](#editing)).

## Drawing { #drawing }

The drawing rail sits on the plot. Its tools stand in groups: lines
(horizontal, vertical, trend), areas (time range, box), then measure and
note. Hover any button for its name and key.

Pick a tool, then:

- **Horizontal line**, **Vertical line** and **Note** place with one click.
- **Trend line**, **Time range**, **Box** and **Measure** take two points:
  drag from the first to the second, or click twice. (Shift-drag measures
  without picking the tool; see [Measuring](#measuring).)

A new note opens its text box right on the plot: type, then press Enter or
click elsewhere to keep it. Escape on a new note removes it (⌘Z / Ctrl+Z
brings it back); on a note you reopen, Escape leaves it as it was.
Double-click a note to change its text later. A locked note keeps its text.

Drawings look like the marks in a printed figure: a fine line in ink (dark on
a light plot, light on a dark one), labels in a small italic serif, and no
filled shapes except a faint tint on a time range.

After placing, the rail goes back to the pointer. The toggles below the tools
are the same in every plot tool:

- **Magnet** snaps each point to the nearest drawn sample within 24 px. The
  drawing then belongs to that curve's axis and keeps the sample's exact
  value.
- **Keep drawing** keeps the tool armed after drawing, so you can place
  several in a row.
- **Data tooltip** shows the values under the cursor (on by default). The
  crosshair has its own setting. In Trace the tooltip follows the cursor;
  turn on **Dock data tooltip** in **Display** to keep it in a corner of the
  plot, away from the cursor, as Correlation and Waveform always do. A
  docked tooltip has a grip (⋮⋮): drag it to put the tooltip anywhere in the
  plot; double-click it to send the tooltip back to its corner.
- **Hide all drawings** hides every drawing of the plot (click again to show
  them). Hidden drawings also stay out of exported images.
- **Zoom box** sets what a left-drag in the plot does: draw a zoom box
  (pressed) or pan. Every tool zooms by default.

### Hiding the rail { #hiding-the-rail }

Turn off **Drawing tools** in the plot's **Display** section to hide the
rail. While it is off, an
armed tool goes back to the pointer and the drawing keys (Alt+H … Alt+M)
do nothing. The drawings you already have stay on the plot: open them from
their cards under **Drawings**, or right-click one, to edit, lock or delete
them.

**Drawings**, in the same section, shows or hides the plot's drawings. It is
the rail's **Hide all drawings** button under another name, so the two always
agree, and it still works while the rail is hidden.

The rail's other toggles have a home in **Display** too: **Data tooltip**,
and **Mouse drag** for the zoom box. **Magnet** and **Keep drawing** have
none: they only matter while drawing, and they keep their last setting while
the rail is hidden (the magnet still applies to **Add … here** and to dragging
a drawing's handles).

A vertical line and a time range span the whole height of the plot; every
other drawing belongs to one Y axis.

### Measuring { #measuring }

Hold **Shift** and drag in the plot for a quick measurement shown while you
drag; it disappears when you let go. The **Measure** tool (drag, or click
twice) draws one that stays. In Trace both show Δ of the value, Δ% against
the first point, Δt, and the number of samples, mean and σ of the curve
under the measurement, written as a figure would (`Δy = −186.5`,
`x̄ = 2950`, `σ = 25.02`). When that curve shows binned archive data, the
count reads in bins and σ is marked approximate. Select a measurement to
drag its readout by the grip beside it; double-click the grip to put the
readout back. Its card in **Drawings** is named for the change it measures,
with the same minus sign (`Measure Δ−21.49 mA / 4 s`).

In Correlation and Waveform x is a value, so the card shows Δx instead of
Δt, and no Δ%:

- **Correlation**: Δx, Δy and Δy/Δx (the slope of the drawn diagonal), then
  the number of points of the drawing's Y series inside the box, their mean
  (ȳ) and σ.
- **Waveform**: Δx and Δy, then for each live curve shown, the number of
  its elements whose x lies inside the measured span, their mean (x̄) and σ.
  With more than one curve, each line starts with the curve's name.

### Editing { #editing }

- **Click** a drawing to select it; **drag** it to move it; drag one of its
  handles to reshape it.
- **Right-click** a drawing, on the plot or its card under **Drawings**, for
  its menu, headed by its name: **Edit** (selects it and opens its card),
  **Lock** or **Unlock**, and **Delete**.
- A selected drawing shows a round **style** button. It opens the drawing's
  color (ink, the color of each plotted curve, or an accent), its line
  width (0.5 to 2 px) and solid or dashed.
- A locked drawing cannot be moved, reshaped or restyled and shows a lock
  instead of handles. On its card, **Color**, **Width**, **Style**,
  **Axis**, **Value** and **Extend** are unavailable ("Locked"), and so is a
  locked note's **Label**. It can still be hidden, unlocked and deleted.
- **Esc** cancels a drawing in progress, then disarms the tool.
- **Delete** or **Backspace** deletes the selected drawing, unless it is
  locked.
- **⌘Z** (macOS) or **Ctrl+Z** undoes the last drawing change of the current
  plot (the selected plot, or the fullscreen or detached plot you are in),
  from any place you made it: the plot, the properties panel or a menu. Each
  plot keeps its own history. There is no redo. Undo history lasts for the
  session; opening a workspace clears it.

### The Drawings list

When a plot has drawings, the properties panel shows a **Drawings** list after
the signals, one card per drawing, named for what it marks (for example
`H-line 2.35 mA` or `Range 12 m 30 s`). The list's eye hides or shows all
of them; each card has its own eye, lock and delete. Drawings stay in
Drawings: they cannot be dragged onto an axis.

Click a drawing's card (or select the drawing on the plot) and it offers:

- **Kind** (read only), **Label**, **Color**, **Width**, **Style**
  (_Solid_ or _Dashed_).
- **Axis**, for the drawings that carry a value.
- **Value**, for a horizontal line.
- **Extend** (_None_, _Right_, _Both_), for a trend line.
- **Delete**. **Locked** and **Visible** are not fields: they are the lock
  and eye buttons on the card's head.

## Drawing in Correlation and Waveform { #other-plots }

Correlation and Waveform offer the same rail, toggles, editing, keys and
properties panel as Trace, and the same drag and double-click gestures on
both axes (a left-drag draws a zoom box by default, as in Trace; a zoom sets
the X and Y scale in **Axes**). The differences:

- The wheel over the plot zooms both axes (**Alt + wheel**: the Y axis
  alone), and dragging a Y axis zooms it (**Shift + drag**: moves it). A
  site can change these ([Site defaults](site-defaults.md)).

- Their x axis is a value, not time, so there is no **Time range** tool
  (Alt+R does nothing) and x reads as a value in labels and the status line.
- In **Correlation** a drawing belongs to one Y series (with **Magnet**, the
  series of the sample it snapped to). Lines, boxes, notes and measurements
  that use x also remember the X PV they were drawn against.
- In **Waveform** every drawing belongs to the one Y axis. A drawing
  remembers the x it was drawn against (element index or the X axis PV)
  and whether **Δ** (_Subtract reference_) was on. While the X axis PV is
  still loading, nothing can be placed.

### Hidden drawings { #hidden-by-context }

A drawing that no longer fits what the plot shows is kept but not drawn.
It stays in the Drawings list, dimmed, with the reason next to it, and comes back by
itself as soon as the plot matches again; nothing is deleted. The reasons:

| Plot        | Reason              | When                                                        |
| ----------- | ------------------- | ----------------------------------------------------------- |
| Correlation | _series removed_    | its Y series is no longer on the plot                       |
| Correlation | _series hidden_     | its Y series is hidden                                      |
| Correlation | _not the density Y_ | the density view shows a different Y                        |
| Correlation | _x source changed_  | the X PV is not the one it was drawn against                |
| Waveform    | _x source changed_  | the plot's x is not the one it was drawn against            |
| Waveform    | _Δ changed_         | Δ is on and it was drawn with Δ off, or the other way round |

A horizontal line uses no x, so it never hides for _x source changed_.

### Drawings in the link { #link-notices }

Correlation and Waveform keep their drawings in the page link, which has a
fixed size. When a link would be too long, Trace makes it fit: note texts are
first shortened to 24 characters, then emptied, and then the last drawings
are left out, one at a time. Only the link is shortened; the drawings on
your plot are unchanged. The status line says what the link lost:

- _N drawings not saved in the link_ when drawings were left out.
- _Note text shortened in the link_ when only note text was cut.

## Keys { #keys }

The keys act on the plot that has focus; clicking a plot, or picking a rail
tool, gives it focus. ⌘Z / Ctrl+Z works anywhere in the window and undoes the
current plot. Keys do nothing while you type in a field.

| Key                | Action                                               |
| ------------------ | ---------------------------------------------------- |
| Alt+H              | Horizontal line                                      |
| Alt+V              | Vertical line                                        |
| Alt+L              | Trend line (Alt+T is the theme toggle)               |
| Alt+R              | Time range                                           |
| Alt+B              | Box                                                  |
| Alt+N              | Note                                                 |
| Alt+M              | Measure                                              |
| ← / →              | Pan time by 10 % of the span                         |
| + / −              | Zoom time in / out by 1.25 about the center          |
| Esc                | Cancel the drawing in progress, then disarm the tool |
| Delete / Backspace | Delete the selected drawing (not a locked one)       |
| ⌘Z / Ctrl+Z        | Undo the last drawing change of the current plot     |

The tool keys (Alt+H … Alt+M) do nothing while the plot's **Drawing tools**
is off; Esc and Delete still act on the drawings you have.

## What the plot tells you { #status-line }

The **status line** under the plot shows the time and the first Y axis's
value under the cursor, and, while a tool is armed, what to do next. Turn it
off with **Status line** in the plot's **Display** section.

**Pin data window**, also in **Display**, fixes the hover readout at the plot's
top-right, so it never covers what is under the pointer. **Dock data
tooltip** keeps it in a corner of the plot instead, moving out of the
cursor's way.

## Saving { #saving }

Drawings are part of the plot:

- A **.trc.json** workspace keeps every drawing of every plot.
- Exported images, printouts and E-Log attachments show the drawings as you
  see them, unless they are hidden.
- An embedded Trace tile keeps the drawings of its **first plot** in its URL,
  up to 64 of them. When the URL runs out of room, the last drawings are
  dropped first (the browser console logs how many were kept); if not even
  one fits, none are kept. A tile always reopens with everything its URL
  kept, also from **Copy link to this view**; a link that is over the limit
  when it arrives (one edited by hand) opens without its drawings, or
  without its plot settings, rather than empty. The status line of
  any other plot in an embedded tile says _Drawings on this plot are not
  saved in the tile_.

Correlation and Waveform links keep drawings as described in [Drawings in
the link](#link-notices).

**Drawing tools** off is saved with the plot: in Trace, in the **.trc.json**
workspace, the config store and the link's `plot=` settings (as
`"showDrawingTools":false`); in Correlation and Waveform, as `rail=0` in the
link. Without that key a plot
opens with the rail shown. **Drawings** (hide all) is not saved.

## For developers { #developers }

The drawing core lives in `src/annotations/`. It knows no plot: everything a
plot differs in comes in through a catalog of tools and a `HostConfig`. The
plot interaction layer it builds on (gestures, projection, strip toggles,
read-out dock, PNG capture) lives in `src/plot/` and is shared by every plot
tool, with or without drawings.

### Adding a tool { #adding-a-tool }

A new tool is **one module, one catalog entry, one line per plot**:

1. **One module.** Create `src/annotations/catalog/<kind>/` with `def.ts`
   (exporting `<KIND>_TOOL: DrawingTool`), `Shape.tsx` and `def.test.tsx`.
   `def.ts` imports only `../types`, `../shapeKit` and `../format`. A
   `DrawingTool` carries everything about the tool: identity (`kind`,
   `code`, `label`, `icon`), placement (`arity` 1 or 2, `axes` `'x'`, `'y'`
   or `'xy'`, the Alt `key`, `menuAdd`, `inlineText`), shape (`shapePoint`,
   `geometry`, `Shape`), text (`objName`, `hint`), its own panel
   `fields` and `validate`, and its link `codec`. Behavior keys on these
   fields, never on a `kind` string.
2. **One catalog entry.** Build the plot's catalog with `makeCatalog` from
   `src/annotations/catalog/index.ts`, for example
   `makeCatalog([...BUILTIN_TOOLS, NEW_TOOL])`. `BUILTIN_TOOLS` is the seven
   built-ins in rail order; `BUILTIN_CATALOG` (Trace) holds all seven,
   `CORRELATION_CATALOG` and `WAVEFORM_CATALOG` the six without the time
   range. There is no module-level tool lookup: everything goes through a
   catalog.
3. **One line per plot.** Pass the catalog as `HostConfig.catalog` in each
   plot that should offer the tool.

`makeCatalog` throws on a duplicate `kind`, `code` or key, on an arity other
than 1 or 2, and on a codec layout whose point count disagrees with the
arity.

Tool **codes** are the wire format of saved files and links, so a code is
never reused:

| Range | Use                  |
| ----- | -------------------- |
| 0–6   | the built-in tools   |
| 100+  | any other (new) tool |
| 900+  | test-only tools      |

The worked example is the test-only crosshair,
`src/annotations/catalog/__fixtures__/cross/def.ts` (code 900), which
`src/annotations/catalog/extensibility.test.tsx` adds to Trace and
Correlation by one catalog line each and round-trips through both link
codecs. `src/annotations/catalog/hline/def.ts` is a small built-in to copy.

### HostConfig { #host-config }

A plot hands its drawing overlay one `HostConfig`
(`src/annotations/catalog/types.ts`), built with `useMemo` and never keyed on
the data frame:

- `catalog` — the tools the plot offers.
- `xAxis` — `TIME_X_AXIS` or `VALUE_X_AXIS` (`catalog/xAxis.ts`): how x is
  formatted and quantized.
- `snap` — the `SnapSource` a Magnet press uses; reads live data through a
  getter.
- `measure` — the `MeasureProvider` for the measure card rows.
- `frames` — the `FrameStore` the plot bumps on each data frame
  (`createFrameStore`, `src/annotations/host/frameStore.ts`); only the
  measure card subscribes.
- `shed` — the `ShedStore` the link writer publishes into; the status line
  reads it for the link notices.
- `ownerAxisAt(px, py, snapHit)` — the axis a new drawing belongs to, or
  null to place nothing.
- `hiddenReason(a)` — why a drawing is hidden right now, or null.

Trace builds its config in `src/tools/trace/drawing/hostConfig.ts`
(`createTraceHostConfig`), Correlation in `src/tools/correlation/Plot.tsx` with
`correlationHiddenReason` from `src/tools/correlation/drawings.ts`, and Waveform
in `src/tools/waveform/Plot.tsx` with `waveformHiddenReason` from
`src/tools/waveform/drawings.ts`.

### Host parts { #host-parts }

`src/annotations/host/` holds the pieces a plot assembles:

- `useDrawingHost` — the `DrawingHost` (config, document and handle), the
  plot menu and wrapper listeners; `shedNoticeOf` turns a shed snapshot into
  the notice text.
- `useDrawingDocument` — the `DrawingDocument` over the host's state and
  undo history.
- `DrawingLayers`, `DrawingRailFor` — the drawing layer with the in-place
  note editor, and the rail.
- `DrawingStatusLine` — the status line, with the link notice.
- `workbench.ts` — `createDrawingSchema` and `createDrawingsSectionSchema`
  for a drawing's card, and `drawingsSection` for the Drawings list, dimmed as stale
  with their hide reason.
- `shedStore.ts`, `hostKeys.ts` (`routeDrawingKey`) and `UndoKeyListener`.

The rail's toggles come from one registry, `PLOT_TOGGLES` in
`src/plot/plotToggles.ts`: a toggle added there appears in every
plot. A plot passes only the values and writers (`DrawingRailFor`'s `view`
and `onView` for the tooltip and drag mode; hide-all appears when the
document has `setHidden`). The plot gestures (wheel, drag, zoom box,
double-click) are `usePlotGestures` in `src/plot/gestures.ts`; a plot
supplies a `PlotGestureSurface`: its grids, axes, value mapping and scale
writers.

The `ann=` link codec Correlation and Waveform share is
`src/annotations/contextLink.ts`; Trace's `plot=` codec is
`src/annotations/config.ts`.

### The import boundary { #import-boundary }

The lint rule `annotations/import-allowlist` (`eslint.config.js`) keeps the
core plot-free: a production module under `src/annotations/` may import only
`src/annotations/**`, `src/plot/**`, `src/workbench/**`, `src/statistics/**`,
`src/chartTheme` and third-party packages. Tests and `__fixtures__` are
exempt. The rule `plot/import-allowlist` keeps `src/plot/` to itself and
third-party packages. Code only Trace needs belongs in `src/tools/trace/drawing/`;
Correlation and Waveform keep theirs in `src/tools/correlation/` and
`src/tools/waveform/`.
