// The readout table: one row per frame row, one column per metric that is
// `on`, in list order; 4 significant digits with the unit the tool resolves
// for the metric's unit kind, "–" for anything undefined. A column whose
// expression does not compile is marked invalid (its header's tooltip names
// the error). A count (`n`, `count(…)`) or an index (`argmin`, `argmax`)
// prints as the integer it is.

import { cellText, shownRows, type MetricTable } from './evaluate';
import type { Metric } from './model';

export interface ReadoutProps {
  table: MetricTable;
  /** The metric list; its `on` entries are the columns. */
  metrics: readonly Metric[];
  /** The unit text of a metric's unit kind for a row ('' for none). */
  unitOf: (rowId: string, unit: string) => string;
  /** The first column's heading ("PV", "Curve"). */
  rowHeading?: string;
}

export function Readout({ table, metrics, unitOf, rowHeading = 'PV' }: ReadoutProps) {
  const columns = metrics.filter((m) => m.on);
  const rows = shownRows(table);
  if (columns.length === 0 || rows.length === 0) return null;
  return (
    <section className="stats-readout" aria-label="Readout">
      <table>
        <thead>
          <tr>
            <th scope="col">{rowHeading}</th>
            {columns.map((metric) => {
              const error = table.errors[metric.id];
              return (
                <th
                  key={metric.id}
                  scope="col"
                  data-testid={`readout-col-${metric.id}`}
                  className={error === undefined ? undefined : 'stats-readout__invalid'}
                  title={error ?? metric.expr}
                >
                  {metric.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid={`readout-${row.id}`}>
              <th scope="row">
                <span
                  className="stats-readout__swatch"
                  style={{ color: row.color }}
                  aria-hidden="true"
                >
                  ●{' '}
                </span>
                {row.label}
              </th>
              {columns.map((metric) => {
                const cell = row.cells[metric.id];
                return (
                  <td key={metric.id} title={cell?.error}>
                    {cellText(metric, cell?.value ?? null, unitOf(row.id, metric.unit))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
