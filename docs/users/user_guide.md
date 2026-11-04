# User Guide

---

## The Trace Window

The Trace window has three areas:

- **① Actions bar** — saving, exporting, printing, and other actions.
- **② Properties panel** — the plot's traces, grouped by Y-axis, and the plot-wide sections **Acquisition**, **Axes**, **Display**, and **Statistics**. See [The properties panel](../workbench.md).
- **③ Plot area** — the plot itself, with plot tabs, range controls, and view controls above it and the drawing tools beside it.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/trace_window.png"><img src="../images/trace_window.png" alt="The Trace window" style="width:80%; border-radius:0.5rem;"></a>
</div>

### Resize and Collapse Panels

Drag the separator between the properties panel and the plot to resize the panel, or collapse it with the button in its header when you want more room for the plot. See [Collapsing and resizing](../workbench.md#collapsing-and-resizing).

---

## Plot a PV

Every plot starts with one empty Y-axis. To plot a process variable (PV), add it to an axis's list in the properties panel. New traces show both archived and live data, so the plot fills the whole time range and keeps updating.

**Workflow:**

1. Click the **Add PV** field under the axis you want to use (①).
2. Type part of the PV name (②). Matching PVs from the archiver appear in a list as you type.
3. Click the PV you want (③), or press **Enter** to use exactly what you typed.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/plot_pv_add_trace.png"><img src="../images/plot_pv_add_trace.png" alt="Add PV field in the properties panel" style="width:80%; border-radius:0.5rem;"></a>
</div>

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/plot_pv_search.png"><img src="../images/plot_pv_search.png" alt="Searching for a PV in the Add PV field" style="width:50%; border-radius:0.5rem;"></a>
</div>

Once you choose a PV, the trace starts drawing:

- **④ Card** — the trace's card in the list of its axis. Click it any time to open its settings in place; see [Signals and cards](../workbench.md#signals-and-cards).
- **⑤ Units axis** — the trace moves to an axis named after the PV's units (here **mm**). See [Axes and Units](#axes-and-units).
- **⑥ Status** — the card's **Data** block shows **Live status** and **Archive status**. Useful when a trace isn't drawing and you want to know why.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/plot_pv_plotted.png"><img src="../images/plot_pv_plotted.png" alt="A PV plotted with live and archive data" style="width:80%; border-radius:0.5rem;"></a>
</div>

### Axes and Units

When you add a PV, Trace looks up its engineering units and moves the trace to the axis with the same units. If there isn't one, Trace creates a new axis named after the units, alternating between the left and right sides of the plot. Traces with the same units share an axis, so they are easy to compare.

You can always move a trace yourself: pick a different axis under **Plot on** in its card, or drag the card onto another axis's list. The original **Y-Axis 1** stays even when it is empty; click **Remove axis** in its block under **Axes** if you don't need it.

### Live and Archive Data

**Data sources:**

- **Live** — streams new values as they arrive. **Live retention** sets how much live history is kept; left empty, it follows the time range.
- **Archive** — loads the plot's time range from the archiver. For ranges longer than 30 minutes, the archiver returns averaged bins, and Trace draws a shaded min/max band behind the line. Turn the band off with **Min/max band**.

Both switches are in the card's **Data** block; the other settings are under its **More**. With both on, archive data covers the past and live data takes over from the last archived sample. Each trace uses the plot's **Default archiver** (in **Acquisition**) unless you choose a different one under **Archiver**.

### When a Trace Doesn't Draw

Check the status lines in the card's **Data** block, or the dot at the left of the card. Hover over the dot to see the full error.

- **Disconnected** (Live status) — the live connection dropped. Trace reconnects on its own.
- **Waiting for value** (Live status) — connected, but no value has arrived for this PV yet.
- **Not archived** — the archiver has no PV with that name. Check the spelling in **PV name**.
- **No archiver** — no archiver is configured for this PV. Choose one in the plot's **Default archiver** setting or the trace's **Archiver** setting.
- Any other archive error shows its error code, for example when the archiver or network isn't responding. Click the refresh icon in the actions bar to try again.

---

## Set the Time Range

Each plot has its own time range. Open **Axes** in the properties panel; the time settings are under **X axis**.

**Time settings:**

- **① Time range** — choose a preset from **Last 30 Seconds** to **Last 1 Month**, or **Custom Range...** for fixed start and end times.
- **② Span** — type any length of time, such as `30s`, `90m`, `1.5h`, or `2w`, and press **Enter**. Units are `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks), and `M` (months).
- **③ Autoscroll (track now)** — keeps the current time at the right edge of the plot.

**Refresh interval**, in **Acquisition**, sets how often, from 1 to 60 seconds, archive and formula data refresh while autoscroll is on. The buttons above the plot (**1h**, **6h**, **24h**, **All**, **Now**) and its date field change the range in one click; see [Moving through time](../drawing-tools.md#navigation).

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/time_range.png"><img src="../images/time_range.png" alt="X axis time settings" style="width:50%; border-radius:0.5rem;"></a>
</div>

### Custom Range

Choose **Custom Range...**, then set **From** and **To (blank = now)**. Leave **To** blank to end the range at the current time. If the range isn't valid (for example, **From** is after **To**), an error appears below the fields and the plot shows the last hour instead.

### Returning to the Full Range

Zooming or panning the plot stops it from following the current time. Click **Now** above the plot to follow the current time again with the last span you used, or choose a **Time range** or **Span**.

---

## Zoom, Pan, and Read Values

**Mouse controls:**

- **Scroll inside the plot** — zoom time and every Y-axis around the pointer. **Shift** + scroll moves along the time axis.
- **Drag inside the plot** — draw a zoom box; the plot zooms to it when you let go. Set **Mouse drag** in **Display** to **Pan** to move along the time axis instead.
- **Scroll over a Y-axis** (②) — zoom only that axis, around the mouse pointer.
- **Drag up or down on a Y-axis** — zoom only that axis in or out.
- **Double-click inside the plot** — show everything loaded and auto-scale every Y-axis.

See [Moving through time](../drawing-tools.md#navigation) and [Scaling the Y axes](../drawing-tools.md#axes) for every gesture. Zooming or panning time stops following the current time (see [Returning to the Full Range](#returning-to-the-full-range)). Zooming a Y-axis switches it from **Auto-scale** to fixed limits; double-click the axis to undo it.

Move the mouse over the plot to see the data tooltip (①) with each trace's value at that time. Each value is the sample nearest the pointer, and the time in parentheses shows how far that sample is from the pointer (for example **+2s**). The tooltip sits in a corner of the plot; drag its grip to move it. Turn **Crosshair** on in **Display** for crosshair lines, or **Data tooltip** off to hide the tooltip.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/read_values.png"><img src="../images/read_values.png" alt="Data tooltip and Y-axis zoom area" style="width:70%; border-radius:0.5rem;"></a>
</div>

The legend below the plot lists the visible traces. Clicking it doesn't hide a trace; use the eye on the trace's card instead, or right-click the entry for the trace's menu (see [Right-click menus](../workbench.md#right-click)).

---

## Work with Axes

A plot can have several Y-axes, each with its own scale, on the left or right side. Traces with different units usually go on different axes.

**Workflow:**

1. In the properties panel, click **Add axis** (②) below the lists. New axes alternate between the left and right sides.
2. Open **Axes**: each Y-axis has its own block there, headed by its name (①).

**Axis settings:**

- **Label** — the axis name shown in the list and along the axis.
- **Unit** — the units shown for the axis; they start from the PV's units.
- **Side** — **Left** or **Right**.
- **Visible** — show or hide the axis. Hiding an axis also hides its traces.
- **Auto-scale** (③) — fit the axis to the data. Turn it off to set **Min** and **Max** yourself.
- **Log scale** (④) — switch between a linear and a logarithmic scale.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/axes.png"><img src="../images/axes.png" alt="Axis settings" style="width:80%; border-radius:0.5rem;"></a>
</div>

### Move Traces Between Axes

Drag a trace's card onto another axis's list, pick an axis under **Plot on** in its card, or right-click the card and use **Move to axis**.

### Delete an Axis

Click **Remove axis** in the axis's block under **Axes**. Its traces move to another axis on the same plot. A plot always keeps at least one axis.

_Note: Deleting an axis, trace, or plot happens immediately, without asking for confirmation._

---

## Style Traces

Click a trace's card to change how it looks. In its **Signal** block, **Label** sets the name used in the legend, tooltip, and card (leave it blank to use the PV name); the eye on the card shows or hides the trace.

**Style block:**

- **① Colour** — pick a colour.
- **② Line** — **Step** (holds each value until the next sample; the default) or **Line** (straight lines between samples).
- **Width** — 0.5 to 20 px.
- **③ Dash** — solid, dashed, dotted, and mixed patterns, or **None** to show only markers.
- **④ Extend to now** — draw a dashed line from the last value to the end of the time range.
- **Alarm colouring** — tint the live curve by each sample's alarm severity.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/trace_style.png"><img src="../images/trace_style.png" alt="Style settings" style="width:50%; border-radius:0.5rem;"></a>
</div>

Turn on **Markers** to mark each sample, then choose a **Marker** and **Marker size**. A dot next to a field means it differs from its automatic value; see [The modified dot and reset](../workbench.md#the-modified-dot-and-reset). **Show chart source**, at the bottom of the panel, shows the chart settings behind the plot.

### Color Palettes

New traces get their colours from the plot's palette. Open **Display**, then **More**, and choose one of 13 palettes under **Palette** (①). Every trace on the plot that still has a palette colour is recoloured; colours you picked yourself stay.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/palette.png"><img src="../images/palette.png" alt="Color palette settings" style="width:50%; border-radius:0.5rem;"></a>
</div>

---

## Formulas

A formula curve calculates new values from other traces, for example the ratio of two detectors or a scaled copy of a signal.

**Workflow:**

1. Click **Add formula** below the lists. The new formula's card (③) is added to the first axis and opens; move it with **Plot on**.
2. Enter a **Label**.
3. Type an expression in the **Formula** box (①). Refer to other traces with variables in braces, such as `{x1}` and `{x2}`. Trace checks the expression as you type and shows **Valid** or an error.
4. Below the box (②), choose the trace each variable stands for.
5. The curve draws once every variable is bound.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/formula.png"><img src="../images/formula.png" alt="Formula editor" style="width:80%; border-radius:0.5rem;"></a>
</div>

Expressions support arithmetic (`+`, `-`, `*`, `/`, and parentheses) and math functions such as `mean`, `ln`, `abs`, and `sqrt`. For example, `{x1} * 1.5 + 10`.

Formula curves are recalculated whenever the plot's time range moves, including with autoscroll.

### Create a Formula from a Trace

Click **Create formula from this curve** in a PV trace's **Data** block, or in its right-click menu. Trace adds a formula curve with `{x1}` already bound to that trace; edit the expression from there. The original trace is unchanged.

_Note: Variables can refer only to PV traces on the same plot, not to other formulas._

---

## Multiple Plots

Add more plots to view different groups of PVs side by side. Each plot has its own axes, traces, time range, and settings.

**View controls** (①, at the right end of the tab bar):

- **Tab view** — show one plot at a time, with a tab for each plot.
- **Grid view** — show all plots at once.
- **Add plot** (**+**) — add a new, empty plot and switch to it.

**Managing plots:**

- **Rename a plot** — open **Display** and edit **Title**.
- **Close a plot** — click **×** on its tab, or in the corner of its grid cell. This appears only when there is more than one plot.

The properties panel shows the active plot. In grid view, click a plot to make it active.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/multiple_plots.png"><img src="../images/multiple_plots.png" alt="Grid view with four plots" style="width:80%; border-radius:0.5rem;"></a>
</div>

### Fullscreen and Separate Windows

Each plot tab and grid cell (②) has the plot's own buttons, among them:

- **Fullscreen** — show the plot over the whole window. Click **×** in its title bar, or press **Escape**, to return.
- **Detach to window** — move the plot into its own browser window. Useful with a second monitor. Click **Reattach** in that window, or close it, to bring the plot back.

_Note: If your browser blocks pop-up windows, the plot stays in the main window. Allow pop-ups for Trace to detach plots._

---

## Inspect Data

The Data Insight tool lists a PV's samples in a table. Useful when you need exact values and timestamps, or want to export one PV's data.

**Open it by:**

- Clicking the Data Insight icon in the actions bar (++option+d++ on macOS, ++alt+d++ elsewhere)
- Clicking **Inspect data** in a trace's **Data** block, or in its right-click menu

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/data_insight.png"><img src="../images/data_insight.png" alt="Data Insight tool" style="width:80%; border-radius:0.5rem;"></a>
</div>

**Controls:**

- **① PV** — choose which PV to inspect. In grid view, the list includes PVs from every plot.
- **② Pages** — the table shows 2,000 rows per page; use the arrows to move between pages.
- **③ Export** — download all rows as **CSV**, **JSON**, or **MAT** (MATLAB). Exports include the PV name, units, and description.
- **④ Pop out, Minimize, Close** — move the tool into its own window, shrink it to a bar below the plot, or close it.

The refresh icon to the left of **Export** loads the data again.

The table covers the plot's current time range and shows each sample's **Datetime** (to the millisecond), **Value**, **Severity**, and **Source** (**Archive** or **Live**). The PV's units and description appear above the table. For very long ranges the archiver may thin out the samples; the row count then shows **(decimated)**.

---

## Save and Open Workspaces

A workspace stores your plots, axes, traces, styles, time ranges, and theme. It doesn't store data; Trace loads the data again when you open the workspace.

- **Save** (++cmd+s++ / ++ctrl+s++) — click the save icon in the actions bar to download the workspace as a `.trc.json` file.
- **Import** (++cmd+o++ / ++ctrl+o++) — click the import icon and choose a workspace file. It replaces whatever is open.

Trace can also open `.trc` files from the older PyDM-based Trace. Settings that have no equivalent are skipped, and Trace lists them in a message after importing.

_Note: Importing replaces the current workspace without asking. Save first if you want to keep it._

---

## Export and Print

- **Export CSV** — downloads one CSV file per plot, named after the plot title. Each row has the PV name, the time (in nanoseconds and as a date), and the value. Archive and formula data are included; traces with only live data are not. For ranges longer than 30 minutes, the archive values are the averaged bins shown on the plot.
- **Export PNG** (++cmd+i++ / ++ctrl+i++) — downloads an image of each plot on screen: the active plot in tab view, every plot in grid view, or the fullscreen plot.
- **Print** (++cmd+p++ / ++ctrl+p++) — prints the plots on screen, arranged in a grid on the page.

Plots detached into separate windows are left out of PNG exports and printouts.

---

## Post to E-Log

Click the E-Log icon in the actions bar (++cmd+e++ / ++ctrl+e++) to post the plots on screen to the E-Log. The icon appears only when Trace is connected to an E-Log.

<div style="text-align:center; margin:1.5rem 0;">
  <a class="glightbox" href="../images/post_elog.png"><img src="../images/post_elog.png" alt="Post to E-Log dialog" style="width:80%; border-radius:0.5rem;"></a>
</div>

**Workflow:**

1. Choose one or more **Logbooks** (①).
2. Enter a **Title** (②) and, optionally, a **Body**.
3. Under **Attach plots** (③), clear any plot you don't want to include. The images are taken when the dialog opens: the active plot in tab view, or every plot in grid view.
4. Check **Attach current configuration** (④) to add the workspace as `trace_config.json`, so others can open the same view in Trace.
5. Click **Post** (⑤). A message in the top-right corner confirms the new entry.

---

## Keyboard Shortcuts

| Action                 | macOS        | Windows / Linux |
| ---------------------- | ------------ | --------------- |
| Save workspace         | ++cmd+s++    | ++ctrl+s++      |
| Import workspace       | ++cmd+o++    | ++ctrl+o++      |
| Print                  | ++cmd+p++    | ++ctrl+p++      |
| Export PNG             | ++cmd+i++    | ++ctrl+i++      |
| Post to E-Log          | ++cmd+e++    | ++ctrl+e++      |
| Data Insight           | ++option+d++ | ++alt+d++       |
| Switch light/dark mode | ++option+t++ | ++alt+t++       |

Shortcuts don't run while you are typing in a text field. The drawing tools have their own keys; see [Keys](../drawing-tools.md#keys).

---

## Icons and Tooltips

Every icon in Trace has a tooltip that appears on hover. Here's a quick reference:

<table style="margin:1.5rem auto; border-collapse:collapse; width:auto;">
  <thead>
    <tr>
      <th style="text-align:center; padding:0.75rem 1.5rem; border-bottom:2px solid #ddd;">Icon</th>
      <th style="text-align:left; padding:0.75rem 1.5rem; border-bottom:2px solid #ddd;">Meaning</th>
    </tr>
  </thead>
  <tbody>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/refresh.png" alt="Refresh icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Refresh archive data</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/data_insight.png" alt="Data Insight icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Open Data Insight</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/post_elog.png" alt="Post to E-Log icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Post to E-Log</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/save.png" alt="Save icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Save workspace</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/print.png" alt="Print icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Print</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/import.png" alt="Import icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Import workspace</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/export_csv.png" alt="Export CSV icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Export CSV</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/export_png.png" alt="Export PNG icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Export PNG</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/theme.png" alt="Theme icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Switch between light and dark mode</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/report_bug.png" alt="Report a bug icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Report a bug</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/docs.png" alt="Docs icon" width="40"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Open the documentation</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/fullscreen.png" alt="Fullscreen icon" width="20"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Show the plot fullscreen</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/detach.png" alt="Detach icon" width="20"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Detach the plot to its own window</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/close_plot.png" alt="Close plot icon" width="20"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Close the plot</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/tab_view.png" alt="Tab view icon" width="28"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Tab view</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/grid_view.png" alt="Grid view icon" width="28"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Grid view</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;"><img src="../images/icons/add_plot.png" alt="Add plot icon" width="28"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle; border-bottom:1px solid #eee;">Add a plot</td></tr>
    <tr><td style="text-align:center; padding:0.4rem 1.5rem; vertical-align:middle;"><img src="../images/icons/delete.png" alt="Delete icon" width="20"></td><td style="padding:0.4rem 1.5rem; vertical-align:middle;">Remove the trace or drawing (on its card)</td></tr>
  </tbody>
</table>

---

## Dark Mode

Click the sun/moon icon in the actions bar (++option+t++ / ++alt+t++) to switch between dark and light mode. Your choice is saved in the browser and used on future visits. Plots with the default background follow the theme; a plot with a custom **Background colour** keeps it.

---

## Getting Help

Click the bug icon in the actions bar to report a problem or request a feature. See [Support and Contact Information](../index.md#support-and-contact-information) for what to include.
