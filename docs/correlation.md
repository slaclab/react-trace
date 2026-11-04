---
icon: lucide/chart-scatter
---

# Correlation

Correlation plots one PV (the X) against up to eight others (the Ys), as a
scatter or a density plot. It uses the shared
[properties panel](workbench.md): the Ys are its **Signals**, the X is the
**X axis PV**, and the **Trigger** list sets when a point is taken.

This page covers what is specific to Correlation's **statistics**. The
panel, the Metrics editor, the expression language and the URL grammar are
the same in every tool and are described on the [Statistics](statistics.md)
page.

## Statistics

Turn on **Show statistics** (the **Statistics** section) and the readout table
docks under the plot: one row per Y and one column per metric. Each value is
computed over the points on screen, so it changes when you change Max points
or Lookback. Below the table, optional **strip charts** plot a metric over
time, one line per Y, on the data clock (the newest row on screen); _Clear_
empties their history.

**The quiet default.** The table shows five columns: n, mean, std, r and
slope. Every strip chart is off. The other built-in metrics are in the list,
turned off.

### Built-in metrics

| Id          | Label     | Expression        | Unit    | On by default |
| ----------- | --------- | ----------------- | ------- | ------------- |
| `n`         | n         | `n`               | none    | yes           |
| `mean`      | mean      | `mean(y)`         | Y       | yes           |
| `std`       | std       | `std(y)`          | Y       | yes           |
| `r`         | r         | `corr(x, y)`      | none    | yes           |
| `slope`     | slope     | `slope(x, y)`     | Y per X | yes           |
| `r2`        | R²        | `r2(x, y)`        | none    | no            |
| `intercept` | intercept | `intercept(x, y)` | Y       | no            |
| `min`       | min       | `min(y)`          | Y       | no            |
| `max`       | max       | `max(y)`          | Y       | no            |
| `p2p`       | p2p       | `ptp(y)`          | Y       | no            |
| `rms`       | rms       | `rms(y)`          | Y       | no            |
| `xmean`     | X mean    | `mean(x)`         | X       | no            |
| `xstd`      | X std     | `std(x)`          | X       | no            |

X statistics are metrics too (_X mean_, _X std_), so the table has rows for
the Ys only. An X metric is computed over the rows where X and that row's Y
are both valid, so it can differ slightly between rows when a Y has gaps.
The r strip is fixed to −1 … 1 and the R² strip to 0 … 1; the others scale
to their data.

### Variables

- `x` is the X PV and `y` is the Y of the row being computed.
- `y1` … `y8` are the Ys by position in the Y list, the same in every row.
- `t` is the time of each point in seconds relative to the newest one, so it
  is 0 or negative.
- `n` is the number of points, and `pi` and `e` are constants.

**Unit** picks the unit shown after the value: none, the Y's unit, the X's
unit, or Y per X.

### In the URL

`readout=1` turns the panel on; the metric list is written as repeated
`m=` keys, as the [Statistics](statistics.md#in-the-url) page describes.
When a URL grows past its 4 KB budget, the `m=` keys are dropped after the
labels, colours, markers and hidden list, and Ys only after that.
