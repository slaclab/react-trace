---
icon: lucide/sigma
---

# Statistics

Every tool — Trace, Correlation and Waveform — shows statistics the same way.
The chart fills the canvas and the statistics are **off** by default. Turn
them on and a panel docks under the chart: a **readout table** first, one row
per curve and one column per metric, the **distribution** of each curve when
you ask for it, and **strip charts** below, one per metric you asked for,
plotting that metric over time. The panel takes what it needs up to about
half the canvas and scrolls inside; the chart shrinks to the rest.

The settings are in the **Statistics** section of the properties panel. In
Trace each plot has its own.

- **Show statistics** shows or hides the whole panel.
- **Show distribution** (while statistics are shown) adds one small chart per
  curve: its values over the tool's frame as a **probability density** — the
  area under each is one, so a curve of 50 samples and one of 5000 sit on one
  scale — with the mean (dashed) and mean ± σ (dotted) as guides, and n, mean
  and σ in the title. Bins follow the Freedman–Diaconis rule, 8 to 64 of them.
  The values are the row's `y`: the view window in Trace, the points on
  screen in Correlation, the elements in range (Δ when Δ is on) in Waveform.
- **Metrics** is the list of metrics. Each row has a checkbox, the metric's
  name over its formula, a strip-chart button and an edit chevron.
  - The **checkbox** makes the metric a column of the table.
  - The **strip-chart button** draws the metric as a strip chart. A metric
    can be a strip without being a column.
  - The **chevron** opens the row. A built-in metric shows its formula,
    _Move up_ / _Move down_ and _Delete_. Your own metric has _Label_,
    _Expression_, _Unit_, _Move up_ / _Move down_ and _Delete_.
  - Deleting a built-in metric removes it from the list. **Reset metrics**
    brings it back.
  - The list order is the column order.
  - **Add metric** appends a new metric, "Metric 1", and opens it with the
    cursor in _Expression_.
- **Reset metrics**, below the list, puts the list back to the default,
  including any built-in metric you deleted. It is disabled while the list
  already is the default.

A strip chart keeps a history of every metric, even one that is not drawn,
so turning a strip on shows its past points at once. _Clear_ (Correlation)
empties the history; it is never saved.

## What each tool computes over

| Tool        | A row is                                        | The values are                                                              | Variables                                                                                                  |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Trace       | a curve of the plot (hidden ones are not shown) | its samples inside the view window (the panned window, else the time range) | `y`, `t` (s to the window end, ≤ 0), `y1…yN`, `n`                                                          |
| Correlation | a Y PV                                          | the points on screen where X and that Y are both valid                      | `x`, `y`, `y1…y8`, `t` (s to the newest row), `n`                                                          |
| Waveform    | a drawn live curve                              | its elements in the element range, after Δ when Δ is on                     | `y`, `i` (element index), `x` (X axis PV), `r`, `s`, `d` (reference, its σ, raw − reference), `y1…y8`, `n` |

`y1`, `y2`… name another row by its position in the tool's **Signals** list
(hidden or undrawn entries count), so a
metric can compare curves: `mean(y) - mean(y1)`. In Correlation every row
shares the same points, so `y - y1` is a vector like any other. In Trace each
curve is sampled at its own times, so a referenced curve is first held onto
this curve's sample times (its last value at or before each one): `y - y1`
then compares the two at the same instants. In Waveform curves may differ in
length: mix them element-wise only at equal lengths (`y - y1`, `corr(y, y1)`);
an element-wise mix of unequal lengths is undefined and shows "–".

### Built-in metrics

**Trace** (on by default in bold): **n · mean · std · min · max**, then last,
first, p-p, rms, median and slope (`slope(t, y)`, in the axis unit per
second).

**Correlation**: **n · mean · std · r · slope**, then R², intercept, min,
max, p2p, rms, X mean and X std. X statistics are metrics too, so the table
has rows for the Ys only. The r strip is fixed to −1 … 1 and the R² strip
to 0 … 1.

**Waveform**: **n · mean · std · rms · p-p**, then min, max, median, _peak
at_ (`at(i, argmax(y))`, the element index of the largest value), _trough
at_, and against the reference _dev rms_ (`rms(d)`), _dev max_
(`max(abs(d))`), _dev σ_ (`max(abs(d) / s)`) and _worst at_ (`at(i,
argmax(abs(d) / s))`); the last four read "–" without a reference (or, for
the σ ones, without a rolling mean or a snapshot frozen from one).

## Writing a metric

Open a metric you added and type its **Expression**. The expression is
checked as you type. A mistake is shown under the field and on the row, but
the expression is still kept, and the table shows "–" for it until it works.

**Rows used.** An expression uses only the points where every variable it
mentions has a finite value. `n` is the number of those points.

**Vectors and scalars.** The column variables (`y`, `x`, `t`, `i`, `y1`…)
are vectors, one value per point. Arithmetic (`+ - * / ^`) works point by
point, and a scalar combines with every point: `y - mean(y)` subtracts the
mean from each point. Aggregates such as `mean`, `std` or `corr` reduce a
vector to one number. The whole expression must end in one number. An
expression that is still a vector, such as `y * 2`, is an error.

**Undefined values** show as "–", never as 0. For example, std needs two
points, r needs three points and spread in both, and slope needs spread in
its first argument.

**Unit** picks the unit shown after the value. The choices depend on the
tool: the curve's axis unit (and per second) in Trace; the Y's unit, the X's
unit or Y per X in Correlation; the axis unit or the X axis PV's unit in
Waveform.

**Examples.**

| Purpose                  | Expression           | Where       |
| ------------------------ | -------------------- | ----------- |
| Noise around the mean    | `std(y - mean(y))`   | any         |
| Drift per second         | `slope(t, y)`        | Trace, Corr |
| Largest excursion        | `max(abs(y))`        | any         |
| Difference of two curves | `mean(y) - mean(y1)` | any         |
| Ratio of means           | `mean(y) / mean(x)`  | Correlation |
| Correlation of two Ys    | `corr(y1, y2)`       | Correlation |
| Element of the peak      | `at(i, argmax(y))`   | Waveform    |
| Value at a given element | `at(y, 100)`         | Waveform    |
| Largest deviation, in σ  | `max(abs(d) / s)`    | Waveform    |
| Mean offset from the ref | `mean(d)`            | Waveform    |

## Function reference

Element-wise functions return a vector for a vector argument. Aggregates
return one number. Standard deviation, variance and covariance are sample
statistics (divided by n − 1).

| Function                  | What it returns                                            |
| ------------------------- | ---------------------------------------------------------- |
| `abs(v)`                  | Absolute value, element-wise.                              |
| `sqrt(v)`                 | Square root, element-wise.                                 |
| `exp(v)`                  | e raised to v, element-wise.                               |
| `ln(v)`                   | Natural logarithm, element-wise.                           |
| `log10(v)`                | Base-10 logarithm, element-wise.                           |
| `log2(v)`                 | Base-2 logarithm, element-wise.                            |
| `sin(v)`                  | Sine of radians, element-wise.                             |
| `cos(v)`                  | Cosine of radians, element-wise.                           |
| `tan(v)`                  | Tangent of radians, element-wise.                          |
| `floor(v)`                | Round down, element-wise.                                  |
| `ceil(v)`                 | Round up, element-wise.                                    |
| `round(v)`                | Round to nearest, halves away from zero, element-wise.     |
| `sign(v)`                 | −1, 0 or 1 by sign, element-wise.                          |
| `pow(a, b)`               | a raised to b, element-wise; same as `a ^ b`.              |
| `count(v)`                | Number of values.                                          |
| `sum(v)`                  | Sum of the values.                                         |
| `mean(v)`                 | Arithmetic mean (needs 1 value).                           |
| `median(v)`               | Middle value; mean of the two middle ones for even counts. |
| `std(v)`                  | Sample standard deviation, ddof = 1 (needs 2 values).      |
| `var(v)`                  | Sample variance, ddof = 1 (needs 2 values).                |
| `rms(v)`                  | Root mean square, sqrt(mean(v²)); not centred.             |
| `ptp(v)`                  | Peak to peak: max(v) − min(v).                             |
| `first(v)`                | The oldest value.                                          |
| `last(v)`                 | The newest value.                                          |
| `argmin(v)`               | 0-based position of the smallest value.                    |
| `argmax(v)`               | 0-based position of the largest value.                     |
| `min(v)` · `min(a, b, …)` | Smallest value; with several arguments, element-wise.      |
| `max(v)` · `max(a, b, …)` | Largest value; with several arguments, element-wise.       |
| `percentile(v, p)`        | p-th percentile, p in 0..100, linear interpolation.        |
| `at(v, k)`                | The k-th value of v (0-based), e.g. `at(i, argmax(y))`.    |
| `corr(a, b)`              | Pearson r (needs 3 rows and spread in both).               |
| `cov(a, b)`               | Sample covariance, ddof = 1 (needs 2 rows).                |
| `slope(a, b)`             | Least-squares slope of b against a (needs spread in a).    |
| `intercept(a, b)`         | Least-squares intercept of b against a.                    |
| `r2(a, b)`                | Coefficient of determination, corr(a, b)².                 |

The same list is in the editor, under **Expression reference** below the
Metrics list.

## In the URL

The metric list is saved as **tokens**, one per metric in column order, and
only when the list differs from the default. When any token is present, the
list is exactly those metrics.

```text
token  = flags body
flags  = [ "-" ] [ "~" ]        "-": not a table column, "~": a strip chart
body   = preset-id | custom
custom = label "=" expr [ "=" unit ]     unit: a kind the tool knows
```

- **Correlation** and **Waveform** write repeated `m=` keys, the toggle as
  `readout=1` (Correlation) or `stats=1` (Waveform), and the distribution as
  `dist=1`. For example,
  `m=n&m=mean&m=~std&m=-r&m=Noise=std(y-mean(y))=y` shows n, mean, std and
  Noise as columns, draws std as a strip, and keeps r in the list but off.
  Tokens are URL-encoded: in a hand-written link, write `+` as `%2B`, since
  a bare `+` in a query means a space.
- **Trace** carries them inside the plot's `plot=` JSON as `"showStats":
true`, `"showDist": true` and `"metrics": ["n", "~mean", …]`, and in saved
  workspaces as the plot's `showStats`, `showDist` and `metrics` fields.

**An empty list** (every metric deleted) has no token to write: Correlation
and Waveform reopen it at the default, Trace keeps it in its plot config.

**Limits.** A label is at most 32 characters and an expression at most 160;
neither may contain `=`. The list holds at most 16 metrics in all, built-in
or your own. Delete built-in metrics you do not need to make room for more of
your own. A token that cannot be read, such as an unknown built-in id, is
dropped. An expression with a mistake is kept.

When a URL grows past its 4 KB budget, Correlation drops the `m=` keys after
the labels, colours, markers and hidden list and before any Y; Waveform
drops them with the curve styles; Trace drops them with the rest of the
plot config. The metrics then reopen at the default.
