---
icon: lucide/panel-left
---

# The properties panel

Trace, Correlation and Waveform share one layout. The **actions bar** runs
across the top, the **canvas** fills the middle, and the **properties panel**
sits beside the canvas. The panel is one page that reads the same in all
three tools:

1. **What is plotted**, as lists:
   - **Signals**: the curves. In Trace they are grouped by Y axis.
   - The tool's peers of the signals: Waveform's **Reference** and
     **X axis PV**, Correlation's **X axis PV** and **Trigger**.
   - **Drawings**, once the plot has any.

   Each list ends with an add row where you type or search for a PV.

2. **How the whole plot behaves**, as sections you open and close. A closed
   section shows a one-line summary:
   - **Acquisition**: how data is taken (time window, persistence, sampling).
   - **Axes**: the Y axis and the X axis (range, scale, unit).
   - **Display**: legend, grid, crosshair, data tooltip, mouse drag and
     the tool's own display options.
   - **Statistics**: the readout table under the chart.
3. **Show chart source**, a link at the bottom.

## Signals and cards

Each signal, reference or drawing is a **card**. Hover a card to show its
visibility eye, lock and remove buttons. Click a card to open it in place.
It shows the card's settings in titled blocks:

- **Signal**: label, and the list it is plotted on (**Plot on**).
- **Style**: colour, line, width, dash and markers.
- **Data** (Trace): live and archive sources and their status.

Click the card again, or press ++escape++, to close it. Selecting a curve or a
drawing on the plot opens its card. To move a signal to another list or axis,
drag the card there, or change **Plot on**. A list that refuses the card says
why and does nothing on drop.

A list's own settings sit under its cards. Examples are the Reference's
**Rolling mean** and **Draw as**, and the Trigger's **Period**.

## The modified dot and reset

Some fields have an automatic value, such as a palette colour, an automatic
axis or an unset option. When you change such a field, a **dot** appears next
to it to show it differs from the automatic value. Use the field's **reset**
to clear the change and go back to the automatic value. A field with no
automatic rule has no dot.

## More

Settings you rarely need sit under a **More** disclosure at the end of a
block or section. It starts closed and stays as you left it while the page
is open.

## Show chart source

**Show chart source** shows the chart configuration of the whole plot with a
**Copy** button. Data is never included: arrays print as `/* n points */`.
Use it to see exactly what is drawn, or to reproduce a plot somewhere else.

## Collapsing and resizing

The panel's header has a **collapse** button. Collapsed, the panel is a 32 px
rail; click the rail to bring it back. Selecting something on the plot brings
it back too. A field you were typing in keeps its draft while the panel is
collapsed.

Drag the separator between the panel and the canvas to resize it.
Double-click the separator to return to the default 300 px (minimum 220 px,
maximum 60 % of the width).

The width and the collapsed state are stored in the browser under the key
`trace.workbench`, and all three tools share them. A page embedded with a
storage scope uses its own key. Only your own clicks and drags write them.

## Where actions live

Commands that act on the whole canvas sit in the **actions bar** above it:
Pause, exports, Snapshot, Post to E-Log and so on, depending on the tool. The
bar ends with the standard actions:

- **Theme** (standalone pages only; inside a host the host sets the theme),
- **Report a bug**,
- **Docs**, which opens this documentation site.

Each action's keyboard shortcut is listed with it in the bar. ++ctrl++ on
Windows and Linux is ++cmd++ on macOS; for example Export PNG is
++ctrl+i++ / ++cmd+i++.

Hidden or disabled:

- An action that your deployment cannot support is **hidden**. For example,
  Post to E-Log only appears when a logbook is configured.
- An action that you cannot use _right now_ stays visible but is
  **disabled**, and the bar tells you why. For example, Export is disabled
  until a frame has been drawn.

Actions on one card sit on the card. Actions on a whole list sit below the
lists (Trace: **Add formula**, **Add axis**).

## Embedding in a host { #embedding }

A host page can embed a tool in an iframe of the same origin. Two query keys
on the iframe's URL tell the tool how it is embedded; the tool reads them once
when it loads:

- `embedded=true`: the tool runs inside a host. The theme follows the host,
  so the theme toggle is gone, and the tool reports its state back to the
  host.
- `hostbar=1` (only together with `embedded=true`): the host draws the tool's
  tile bar and its verbs. The actions bar is hidden, but every keyboard
  shortcut still works; ++ctrl+s++ / ++cmd+s++ asks the host to save its view;
  the plot area draws no verbs of its own; and the tool reports its actions
  so the host can draw and invoke them.

The tool and the host talk through nine messages. Every message is posted
with `postMessage` at the page's own origin, and the tool accepts a message
only when it comes from `window.parent` at that same origin.

| Type                      | Direction   | When                                                                        | Payload                                                                                                    |
| ------------------------- | ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `canopy:quick-open`       | tool → host | `embedded=true`: ++ctrl+k++ / ++cmd+k++ outside a text field                | none                                                                                                       |
| `canopy:save-view`        | tool → host | `hostbar=1`: ++ctrl+s++ / ++cmd+s++, even in a text field                   | none                                                                                                       |
| `canopy:tool-actions`     | tool → host | `hostbar=1`: on load and whenever an action changes                         | `version: 1`; `state` (optional one-line state, e.g. `2 curves · live`); `actions`; `links: {docs?, bug?}` |
| `canopy:tool-invoke`      | host → tool | `hostbar=1`: the operator picks a reported entry                            | `id`                                                                                                       |
| `canopy:trace-ready`      | tool → host | `embedded=true`: once, when the tool listens                                | none                                                                                                       |
| `canopy:trace-visibility` | host → tool | `embedded=true`: the host shows or hides the tool; hidden, it stops polling | `visible` (boolean)                                                                                        |
| `canopy:trace-theme`      | host → tool | `embedded=true`: after `canopy:trace-ready` and when the host theme changes | `mode` (`light` or `dark`); `theme` (optional host theme id, ignored when invalid)                         |
| `canopy:trace-query`      | tool → host | `embedded=true`: 500 ms after the last change to Trace's first plot         | `query` (Trace's link query, no leading `?`)                                                               |
| `canopy:trace-open`       | tool → host | `embedded=true`: the operator opens another tool                            | `tool` (registry id); `query` (that tool's query, no leading `?`)                                          |

Each entry of `actions` has `id`, `label`, `kind` (`button` or `toggle`),
`placement` (`bar` or `menu`), and when they apply `pressed`, `disabled` (the
reason, as text), `shortcut` and `icon` (a Carbon icon component name). Bar
entries come first, in the bar's display order, then the menu entries in
menu order. An action the deployment hides is not reported. The tool runs a
`canopy:tool-invoke` only for an `id` that its last report listed and did not
disable; any other `id` is ignored.

## Right-click menus { #right-click }

Right-click a signal's card, or its entry in the plot legend, for its menu.
The first line is the full PV name. Right-click inside the plot for a menu
about the point under the pointer; its first line is the reading there. The
three tools share one list of actions, so the same action has the same name
and place everywhere.

On a signal:

- **Copy PV name** (or ++ctrl+c++ / ++cmd+c++ while the menu is open).
  ++ctrl++/++cmd++- or ++shift++-click cards to pick several, then right-click
  one of them: the names are copied one per line, and Hide and Remove act on
  all of them.
- **Copy value at cursor** (Trace: the value at the last time you pointed at
  in the plot, else the latest), **Copy this shot** (Waveform: the array, one
  value per line), **Copy fit** (Correlation, while the fit is on).
- Waveform: **Use as reference** (moves the PV to Reference) and **Take
  snapshot as reference**. Correlation: **Use as X**, which swaps it with the
  current X.
- **Open in ›** another tool (Trace, Waveform, Correlation as X or as Y).
  Trace adds **Correlate against** another PV of the same plot.
- **PV info…**: units, limits and description of the channel.
- Trace: **Inspect data**, **Create formula from this curve**, **Move to
  axis ›**. Every tool: **Hide** and **Remove**.

On a point: **Copy reading**, **Copy PV name** of the nearest curve, **Add
note here** (and the other drawings), **Reset zoom**, **Copy plot as image** and **Copy link to this view**. Waveform adds **Copy
this shot**, **Use this shot as reference** and **Freeze this shot**, which
keeps the shot on the plot, dotted, without pausing; choose **Release frozen
shot** to drop it. Correlation adds **Copy fit**.

Each copy is confirmed at the bottom of the tool for two seconds.

## Defaults

All three tools open the same way: the **crosshair is off** and a **mouse
drag zooms** (a zoom box). Change either in **Display**, or with the drag
toggle on the plot's tool strip.
