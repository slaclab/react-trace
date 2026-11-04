/**
 * A line series' data as points: `[t, v]` pairs from the flat typed array the
 * option builder hands ECharts for an unbroken line, or the point data itself.
 */
export function seriesPoints(data: unknown): unknown[] {
  if (!(data instanceof Float64Array)) return data as unknown[];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < data.length; i += 2) out.push([data[i], data[i + 1]]);
  return out;
}
