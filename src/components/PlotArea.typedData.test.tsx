// @vitest-environment jsdom
//
// The option SinglePlot builds must load in real ECharts. Line and extension
// series carry flat [t0, v0, t1, v1, ...] Float64Array data, and ECharts'
// development build asserts that typed-array data declares its `dimensions`
// ("dimensions must be given if data is TypedArray."). Production builds strip
// the assert, so only `pnpm dev` crashed, as soon as Add Trace made a series.
// Mounts SinglePlot with canopy-charts' CanopyChart stubbed out, then hands the
// captured option to a server-side ECharts instance (NODE_ENV is "test", so the
// development asserts are live) and reads the values back out of its store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as echarts from 'echarts';
import { SinglePlot } from './PlotArea';
import type { Plot, PVTrace } from '../types';
import type { AlarmSeverity } from '../api/types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { chartStub } from '../test/chartStub';

type Series = Record<string, unknown> & { id: string; type: string; data: unknown };
interface Option {
  series: Series[];
}

const { lastOption } = vi.hoisted(() => ({ lastOption: { current: null as unknown } }));

// No instance: the chart never becomes ready, so SinglePlot's effects bail out
// early without one.
vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.onRender = (props) => {
  lastOption.current = props.option;
};

const FROM_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const TO_MS = FROM_MS + 60_000;
const at = (s: number) => FROM_MS + s * 1000;

function makeTrace(over: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'SIM:SINE',
    displayName: 'SIM:SINE',
    color: '#ff00aa',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    updateRate: '1s',
    useArchive: true,
    lineWidth: 2,
    lineType: 'direct',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 4,
    data: [],
    ...over,
  };
}

function makePlot(traces: PVTrace[], xAxis: Plot['xAxis']): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes: [
      {
        id: 'ax1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis,
  };
}

const CUSTOM_WINDOW: Plot['xAxis'] = {
  timeRange: 'custom',
  timeFrom: new Date(FROM_MS).toISOString(),
  timeTo: new Date(TO_MS).toISOString(),
};

type Pt = [seconds: number, value: number, severity?: AlarmSeverity];
const samples = (pts: Pt[]) =>
  pts.map(([s, value, severity = 'NO_ALARM']) => ({ time: at(s), value, severity }));

const raw = (pts: Pt[]): ArchiveSeriesResult => ({
  status: 'ready',
  mode: 'raw',
  mean: samples(pts),
  band: [],
});

function mount(
  traces: PVTrace[],
  archive: Map<string, ArchiveSeriesResult>,
  { following = false, xAxis = CUSTOM_WINDOW }: { following?: boolean; xAxis?: Plot['xAxis'] } = {}
): Option {
  const { unmount } = render(
    <SinglePlot
      plot={makePlot(traces, xAxis)}
      endMs={TO_MS}
      following={following}
      archiveResults={archive}
      liveResults={new Map()}
      formulaResults={new Map()}
    />
  );
  unmount();
  return lastOption.current as Option;
}

// ECharts measures label text on a canvas, which jsdom doesn't have. A rough
// width is enough to lay out the axes.
echarts.setPlatformAPI({ measureText: (text = '') => ({ width: text.length * 6 }) });

let chart: echarts.ECharts | null = null;
afterEach(() => {
  chart?.dispose();
  chart = null;
});

// Hands the option to the chart the way CanopyChart does (via echarts-for-react).
function update(c: echarts.ECharts, option: Option) {
  c.setOption(option as unknown as echarts.EChartsOption, { replaceMerge: ['series', 'yAxis'] });
  c.renderToSVGString();
}

// Loads the option into a new server-side chart.
function load(option: Option): echarts.ECharts {
  chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 });
  update(chart, option);
  return chart;
}

// A series' values as ECharts stores them, read through its x and y mapping.
function stored(c: echarts.ECharts, id: string): [number, number][] {
  const model = (
    c as unknown as {
      getModel(): {
        getSeries(): {
          id: string;
          getData(): {
            count(): number;
            mapDimension(coordDim: string): string;
            get(dim: string, idx: number): number;
          };
        }[];
      };
    }
  ).getModel();
  const series = model.getSeries().find((s) => s.id === id);
  if (!series) throw new Error(`no series ${id}`);
  const data = series.getData();
  const x = data.mapDimension('x');
  const y = data.mapDimension('y');
  return Array.from({ length: data.count() }, (_, i) => [data.get(x, i), data.get(y, i)]);
}

const typedSeries = (opt: Option) =>
  opt.series.filter((s) => ArrayBuffer.isView(s.data) && !(s.data instanceof DataView));

function expectTypedSeriesDeclareDimensions(opt: Option) {
  for (const s of typedSeries(opt)) {
    expect(s.dimensions, `series ${s.id}`).toEqual(['x', 'y']);
  }
}

describe('PlotArea: option loads in ECharts with typed-array series data', () => {
  it('loads a just-added trace with no samples yet (the Add Trace crash)', () => {
    const opt = mount([makeTrace()], new Map([['t1', raw([])]]));
    const line = opt.series.find((s) => s.id === 't1')!;
    expect(line.data).toBeInstanceOf(Float64Array);
    expectTypedSeriesDeclareDimensions(opt);
    expect(stored(load(opt), 't1')).toEqual([]);
  });

  it('stores time in x and value in y for the line and its frozen extension', () => {
    const opt = mount(
      [makeTrace()],
      new Map([
        [
          't1',
          raw([
            [10, 1],
            [20, 2],
            [30, 3],
          ]),
        ],
      ])
    );
    expect(typedSeries(opt).map((s) => s.id)).toEqual(['t1', 't1-extension']);
    expectTypedSeriesDeclareDimensions(opt);

    const c = load(opt);
    expect(stored(c, 't1')).toEqual([
      [at(10), 1],
      [at(20), 2],
      [at(30), 3],
    ]);
    // A frozen plot's extension: dense anchors from the last sample to the edge.
    const ext = stored(c, 't1-extension');
    expect(ext).toHaveLength(2048);
    expect(ext[0]).toEqual([at(30), 3]);
    expect(ext.at(-1)).toEqual([TO_MS, 3]);
    expect(ext.every(([, v]) => v === 3)).toBe(true);
  });

  it("loads a following plot's two-point extension", () => {
    const opt = mount([makeTrace()], new Map([['t1', raw([[50, 7]])]]), {
      following: true,
      xAxis: { timeRange: '-1m' },
    });
    expectTypedSeriesDeclareDimensions(opt);
    expect(stored(load(opt), 't1-extension')).toEqual([
      [at(50), 7],
      [TO_MS, 7],
    ]);
  });

  it('keeps reading a line that switches between typed and point data on one chart', () => {
    const typedAgain: Pt[] = [
      [10, 1],
      [20, 2],
      [40, 4],
      [50, 5],
    ];
    const withInvalid: Pt[] = [
      [10, 1],
      [20, 2],
      [30, 99, 'INVALID'],
      [40, 4],
    ];
    const c = load(mount([makeTrace()], new Map([['t1', raw(typedAgain.slice(0, 2))]])));

    // An INVALID sample arrives: the same series id now gets [t, v] pairs.
    const broken = mount([makeTrace()], new Map([['t1', raw(withInvalid)]]));
    expect(Array.isArray(broken.series.find((s) => s.id === 't1')!.data)).toBe(true);
    update(c, broken);
    expect(stored(c, 't1')).toEqual([
      [at(10), 1],
      [at(20), 2],
      [at(30), NaN],
      [at(40), 4],
    ]);

    // And back to typed once it's gone.
    update(c, mount([makeTrace()], new Map([['t1', raw(typedAgain)]])));
    expect(stored(c, 't1')).toEqual(typedAgain.map(([s, v]) => [at(s), v]));
  });

  it('still loads point data for a line broken by an INVALID sample, with its band', () => {
    const pts: Pt[] = [
      [10, 1],
      [20, 99, 'INVALID'],
      [30, 3],
    ];
    const binned: ArchiveSeriesResult = {
      status: 'ready',
      mode: 'binned',
      mean: samples(pts),
      band: samples(pts).map((p) => ({ ...p, min: p.value - 1, max: p.value + 1 })),
    };
    const opt = mount([makeTrace({ lineType: 'step' })], new Map([['t1', binned]]));
    expect(Array.isArray(opt.series.find((s) => s.id === 't1')!.data)).toBe(true);
    expectTypedSeriesDeclareDimensions(opt);

    const c = load(opt);
    // The step line holds the last good value up to the INVALID sample, then breaks.
    expect(stored(c, 't1')).toEqual([
      [at(10), 1],
      [at(20), 1],
      [at(20), NaN],
      [at(30), 3],
    ]);
    // The band breaks and holds with it.
    expect(stored(c, 't1-band-min')).toEqual([
      [at(10), 0],
      [at(20), 0],
      [at(20), NaN],
      [at(30), 2],
    ]);
  });

  it('LTTB-samples a dense typed line on its values, keeping a one-sample spike', () => {
    // 6000 samples over the minute, far more than the ~500 px plot is wide, all
    // zero but one. Sampling on the wrong dimension would drop the spike.
    const n = 6000;
    const spikeAt = 4321;
    const dense: ArchiveSeriesResult = {
      status: 'ready',
      mode: 'raw',
      mean: Array.from({ length: n }, (_, i) => ({
        time: FROM_MS + (i * 60_000) / n,
        value: i === spikeAt ? 100 : 0,
        severity: 'NO_ALARM' as const,
      })),
      band: [],
    };
    const opt = mount([makeTrace()], new Map([['t1', dense]]));
    expectTypedSeriesDeclareDimensions(opt);

    const line = stored(load(opt), 't1');
    expect(line.length).toBeLessThan(n / 2);
    expect(line).toContainEqual([FROM_MS + (spikeAt * 60_000) / n, 100]);
  });
});
