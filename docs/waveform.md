---
icon: lucide/audio-waveform
---

# Waveform

Waveform draws array PVs live, one curve per PV, with the element index (or
another PV) on the X axis. It uses the shared
[properties panel](workbench.md).

## Lists

The panel's top block has three lists:

| List          | Holds                                 | Notes                                                                                 |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| **Signals**   | up to 8 waveform PVs                  | Drawn on one Y axis; **Axes › Y axis** sets Unit, Auto-scale, Min, Max and Log scale. |
| **Reference** | one PV, a snapshot, or a rolling mean | Drawn as a dashed line or a shaded band (_Draw as_, under the Reference's cards).     |
| **X axis PV** | one PV                                | Its values become the X axis. Its card's _Label_ titles the X axis.                   |

Only waveform PVs can be added. A scalar PV is refused at the add row.

To move a curve between lists, use its **Plot on** field or drag its card.
Moves never lose a PV. Moving into an occupied Reference or X axis PV swaps
the two PVs, and a snapshot reference is replaced. The only move that is
refused is one into a full Signals list ("Live is full (8/8)"). Styles
(Label, Colour, Line, Width, Dash) belong to the PV, so a curve keeps them
when it moves between Signals and Reference.

**One axis, one unit.** The Live axis takes the engineering unit of the first
PV, in order, that has one. A PV with a different unit stays in its list
but is not drawn, and its card tells you to open a new Waveform tab for it.

## Snapshot → reference

**Snapshot → reference** in the actions bar copies the last drawn frame of
every visible live curve into the Reference list as a _snapshot_. It
happens at once, with one click and no dialog.

A snapshot is **session-only**. It is never written to the URL, a saved view
or the page state, so a reload or a shared link does not have it. To keep a
reference, use a Reference **PV** instead.

The Reference list shows its **Source** under its cards, for example
"Snapshot 14:02:31 of 3 curves — this session only".

The button is disabled, with its reason, until some curve has data.

Right-click a curve's card or legend entry and choose **Take snapshot as
reference** for the same snapshot, or **Use as reference** to make that PV the
reference. Right-click the plot for **Use this shot as reference** and
**Freeze this shot** ([Right-click menus](workbench.md#right-click)).

## Rolling mean reference { #rolling-reference }

Turn on **Rolling mean** (under the Reference's cards)
and every live curve gets its own reference: the element-by-element **mean of
its frames over the last _Window_ seconds** (default 60 s, 1 s to 1 h). With
it comes a **σ per element** over the same frames, drawn as the **Spread
band** (±1σ by default; ±2σ, ±3σ or none) in the curve's colour. The band is
the probability picture along the index: how far each element usually
strays. With Δ on, the live curve is drawn as its deviation from its rolling
mean and the band sits around zero, so an element outside the band is
deviating more than it has over the window.

- Turning Rolling mean on replaces any PV or snapshot reference, exactly as
  Snapshot → reference does; turning it off clears the reference.
- The reference row reads **collecting** until some curve's window holds two
  frames (a σ exists). Δ never waits for it: a curve subtracts its own mean as
  soon as it has a frame.
- The window keeps at most 600 frames per curve (fewer for long waveforms:
  32 MB per curve), thinning fast arrivals, so a 60 s window of a 10 Hz PV
  keeps every frame and a 1 kHz PV one in ten. It starts again when the PV
  reconnects or its length changes. Shortening the Window and lengthening it
  again keeps the frames in between.
- On a logarithmic Live axis the band is not drawn (its lower edge can be
  zero or negative); the rolling mean and Δ still are.
- Averaging (_Average_) does not feed the window: it is the raw frames.
- The rolling reference **is** written to the URL (`roll=60`) and to a saved
  view, with Δ (`delta=1`) and the band (`spread=2`), since a reload rebuilds
  it. Its history is not: a reopened page starts collecting again.

**Record a minute, then hold it.** Let the window fill, then click
**Snapshot → reference**: with a rolling reference in place the button
freezes the current rolling mean _and its σ_ into a snapshot ("Snapshot
14:02:31 of 3 curves of rolling 60 s"). The band stays, the reference stops
moving. Like any snapshot, it is session-only.

## Δ: subtract reference { #subtract-reference }

Turn on **Subtract reference** (under the Reference's cards) to draw
**live − reference** element by element instead of the raw curves. The field
appears once there is a reference.

- **Against a reference PV**: every live curve subtracts that PV's latest
  frame. Until the reference has sent a frame, no live curve is drawn, and the
  canvas reads "Δ needs a reference frame — waiting for …".
- **Against a snapshot**: each curve subtracts _its own_ entry in the
  snapshot. A curve that was not in the snapshot, or whose data restarted
  after the snapshot was taken (reconnect or length change), is not drawn and
  is marked **not in snapshot**.
- **Against a rolling mean**: each curve subtracts its own rolling mean; see
  [Rolling mean reference](#rolling-reference).
- A curve whose length differs from its reference frame is not drawn and is
  marked **length mismatch**.

Δ is written to the URL (`delta=1`) only together with a reference PV or a
rolling mean. Δ against a snapshot is session-only, like the snapshot.

## Persistence and averaging

Both are in the **Acquisition** section:

- **Persistence** (1–16; 1 = off) overlays the last N frames of each curve,
  older frames fading out. Curves drawn as bars show only the latest frame.
- **Average** (1–64; 1 = off) draws each element as the mean of the last N
  frames. Missing or non-numeric samples are skipped, not counted as zero.

Each curve keeps as many frames as the larger of the two settings. Its history
starts again when the PV reconnects, when its length changes, and when the
curve is hidden.

Under **More**:

- **Element range** draws only elements _first_ to _last_ (0-based,
  inclusive; leave a side empty for "to the end").
- **Decimation** caps the points drawn per curve (default 4096; 0 draws
  every point).
- **Update-rate cap** (1–10 Hz; 10 follows every update).

**Pause** in the actions bar freezes the drawing. Data keeps arriving in the
background and is drawn again when you resume.

## The X-axis PV rule

With a PV in **X axis PV**, the X axis can use that PV's values instead of
the element index (**Axes › X axis**, **Plot against**: _Element #_ or
_X axis PV_).

One rule decides whether the X axis PV can be used. A live curve is a
_candidate_ when it is connected, has data, has an accepted unit and, with Δ
on, has its reference's length. The X axis PV is **usable** when it is
connected, has data, is numeric and has the same length as at least one
candidate.

- **Usable**: candidates are drawn against the X axis PV's values. A curve of
  another length is hidden and marked **length mismatch**.
- **Not usable**: every curve is drawn against the element index, the X axis
  reads **Element**, and the X axis PV's card says why.

## Statistics

Turn on **Show statistics** (the **Statistics** section) and the shared
statistics panel docks under the chart, one row per drawn live curve. The
panel, the Metrics editor and the expression language are described on the
[Statistics](statistics.md) page. What Waveform computes over:

- the elements of the published frame inside the **element range**, after Δ
  when Δ is on, never over decimated data;
- `y` is the curve's values, `i` the element index of each, `x` the X axis
  PV's value of each (the index without a usable X axis PV), `y1` … `y8` another
  live curve by list order, `n` the number of finite elements in range;
- `r` is the reference the curve subtracts (PV frame, snapshot entry or
  rolling mean), `s` its σ per element (a rolling mean, or a snapshot frozen
  from one) and `d = raw − r` the deviation, whether or not Δ is drawn;
  without a reference (or σ) a metric that uses them reads "–";
- the default columns are **n · mean · std · rms · p-p**; min, max, median,
  _peak at_ (`at(i, argmax(y))`), _trough at_, _dev rms_ (`rms(d)`), _dev
  max_ (`max(abs(d))`), _dev σ_ (`max(abs(d) / s)`, the largest deviation in
  units of σ) and _worst at_ (the element of that deviation) are in the list,
  off;
- strip charts tick once per published frame; **Show distribution** adds the
  density of each curve's values (see [Statistics](statistics.md)).

In the URL `stats=1` turns the panel on, `dist=1` the distribution block,
and repeated `m=` keys carry the metric list when it differs from the default.

## What the canvas tells you

When nothing can be drawn, the canvas shows the first of these messages that
applies:

1. **Add a waveform PV**: the Signals list is empty.
2. **Δ needs a reference frame — waiting for …**: see [Δ](#subtract-reference).
3. **No curve can be drawn — see the Waveforms list**, with counts. Each row
   says why it is not drawn.
4. **waiting for data**.

## Link format { #link-format }

The tool's state travels in its page URL: the query a host page, a saved
view or a link opens the tool with, and the one it reports back to an
embedding host. `src/tools/waveform/query/` is the only parser of this
grammar.

| Key                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pv=<pv>`                                | A Live waveform, repeated, in colour order; deduplicated, at most 8.                                                                                                                                                                                                                                                                                                                                                   |
| `ref=<pv>`                               | The Reference PV (0–1). A snapshot reference is session data and is never written.                                                                                                                                                                                                                                                                                                                                     |
| `roll=<1..3600>`                         | A rolling reference instead: per live curve, the mean of its frames over the last N seconds.                                                                                                                                                                                                                                                                                                                           |
| `spread=<0..3>`                          | The ±kσ band around a reference that has a σ (rolling, or a snapshot frozen from one); default 1, 0 = none.                                                                                                                                                                                                                                                                                                            |
| `xs=<pv>`                                | The X-source PV (0–1); absent means element index.                                                                                                                                                                                                                                                                                                                                                                     |
| `xl=<label>`                             | The X-source item's Label (the X-axis title).                                                                                                                                                                                                                                                                                                                                                                          |
| `xaxis=index`                            | X axis on element index even with an X source (default: from the X source when one is set).                                                                                                                                                                                                                                                                                                                            |
| `delta=1`                                | Subtract reference; written only together with `ref` or `roll` (Δ against a snapshot is session state).                                                                                                                                                                                                                                                                                                                |
| `persist=<1..16>`                        | Overlay the last N frames (default 1 = off).                                                                                                                                                                                                                                                                                                                                                                           |
| `avg=<1..64>`                            | Average over N frames (default 1 = off).                                                                                                                                                                                                                                                                                                                                                                               |
| `hz=<1..10>`                             | Update-rate cap (default 10 = Hare's cadence, i.e. off).                                                                                                                                                                                                                                                                                                                                                               |
| `elems=<first>:<last>`                   | Element range, 0-based inclusive; either side may be empty (`elems=10:`); absent = all.                                                                                                                                                                                                                                                                                                                                |
| `dec=<0\|256..100000>`                   | Decimation, points drawn per curve (default 4096; 0 = off).                                                                                                                                                                                                                                                                                                                                                            |
| `draw=band`                              | Reference drawn as a shaded band (default: dashed line).                                                                                                                                                                                                                                                                                                                                                               |
| `legend=0` `grid=0`                      | Display toggles that are on by default.                                                                                                                                                                                                                                                                                                                                                                                |
| `cross=1` `stats=1`                      | Display toggles that are off by default (crosshair, Show statistics).                                                                                                                                                                                                                                                                                                                                                  |
| `tip=0`                                  | The hover read-out off (on by default).                                                                                                                                                                                                                                                                                                                                                                                |
| `drag=pan`                               | A left-drag in the plot pans (default: draws a zoom box).                                                                                                                                                                                                                                                                                                                                                              |
| `dist=1`                                 | Show distribution (the statistics panel's density block).                                                                                                                                                                                                                                                                                                                                                              |
| `m=<token>`                              | One statistics metric, repeated, in column order: a preset id or a custom `label=expr[=unit]`, `-` first when it is not a table column, `~` when it is a strip chart. Written only when the list differs from the default, and then all of them.                                                                                                                                                                       |
| `yauto=0` `ymin=<n>` `ymax=<n>` `ylog=1` | The Live axis scale; min/max apply only when auto is off and are kept otherwise.                                                                                                                                                                                                                                                                                                                                       |
| `xauto=0` `xmin=<n>` `xmax=<n>`          | The X axis scale, in the drawn X's units, the same way.                                                                                                                                                                                                                                                                                                                                                                |
| `hide=<pv>`                              | A hidden Live or Reference curve, repeated.                                                                                                                                                                                                                                                                                                                                                                            |
| `plot=<json>`                            | Per-curve styles in Trace's positional form, `{"v":1,"traces":[…]}`: one entry per `pv` key in order, then one for the `ref` PV; fields `displayName`, `color`, `lineType` (line, step, bars, points), `lineWidth` (0.5–20), `lineStyle` (solid, dashed, dotted, dashDot, dashDotDot). An unknown value or an empty entry is automatic; trailing empties are trimmed and the key is omitted when every entry is empty. |
| `ann=<json>`                             | The drawings, in the shared context-link form: the axis reference is always `y`, a magnet trace is its curve PV, and each drawing's `xRef`/`delta` goes in the binding table. Written last; omitted when there are none. A drawing placed against Δ while the reference is a snapshot is session data and is never written.                                                                                            |

The query is URL-encoded, has no leading `?` and is at most 4 KB. Every key
is omitted at its default. Unknown keys are ignored; invalid values fall back
to their defaults, with one console warning per parse naming every key that
did. Over 4 KB, a query carrying `ann` is retried without it; otherwise it is
rejected whole and the defaults open.

A link that would exceed 4 KB is shortened in a fixed order, with one
warning: first the labels (the `plot` labels and `xl`), then the whole `plot`
and the `m` keys (the metrics reopen at the default), then the drawings (note
text trimmed, then drawings dropped from the end, leaving room for the page
keys), then trailing Live PVs. `ref` and `xs` are never dropped.
