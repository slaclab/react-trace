import { describe, it, expect } from 'vitest';
import { convertStripTool } from './striptool';

// Mirrors the reconstructed example in STP_FORMAT.md §9: 2 curves, defaults
// for background/foreground/grid, first 2 of the 10 palette colors.
const SAMPLE_STP = `StripConfig                  1.2
Strip.Time.Timespan          300
Strip.Time.NumSamples        7200
Strip.Time.SampleInterval    1.000000
Strip.Time.RefreshInterval   1.000000
Strip.Color.Background       65535     65535     65535
Strip.Color.Foreground       0         0         0
Strip.Color.Grid             49087     49087     49087
Strip.Color.Color1           0         0         65535
Strip.Color.Color2           29492     56026     13107
Strip.Option.GridXon         1
Strip.Option.GridYon         1
Strip.Option.AxisYcolorStat  1
Strip.Option.GraphLineWidth  2
Strip.Curve.0.Name           ExampleIOC:TempAI
Strip.Curve.1.Name           ExampleIOC:PressureAI
Strip.Curve.0.Units          degC
Strip.Curve.1.Units          psi
Strip.Curve.0.Comment        Reactor core temperature
Strip.Curve.1.Comment        Inlet line pressure
Strip.Curve.0.Precision      2
Strip.Curve.1.Precision      3
Strip.Curve.0.Min            0.00
Strip.Curve.1.Min            0.000
Strip.Curve.0.Max            100.00
Strip.Curve.1.Max            500.000
Strip.Curve.0.Scale          0
Strip.Curve.1.Scale          0
Strip.Curve.0.PlotStatus     1
Strip.Curve.1.PlotStatus     1
`;

describe('convertStripTool', () => {
  it('imports curves, per-curve axes, palette colors, and the relative timespan', () => {
    const result = convertStripTool(SAMPLE_STP);
    expect(result.source).toBe('striptool');
    const plot = result.plots[0];

    expect(plot.xAxis).toEqual({ timeRange: '-300s' });

    expect(plot.traces).toHaveLength(2);
    const [t1, t2] = plot.traces;
    expect(t1.pvName).toBe('ExampleIOC:TempAI');
    expect(t2.pvName).toBe('ExampleIOC:PressureAI');
    expect(t1.useLive).toBe(true);
    expect(t1.useArchive).toBe(false);
    expect(t1.lineWidth).toBe(2);
    expect(t1.color).toBe('#0000ff');
    expect(t2.color).toBe('#73da33');

    expect(plot.axes).toHaveLength(2);
    const axis1 = plot.axes.find((a) => a.id === t1.axisId)!;
    expect(axis1.min).toBe(0);
    expect(axis1.max).toBe(100);
    expect(axis1.logScale).toBe(false);
    expect(axis1.units).toBe('degC');

    // Comments have no equivalent field; both curves should warn once.
    expect(result.warnings.filter((w) => w.includes('dropped'))).toHaveLength(2);
  });

  it('treats a curve hidden by PlotStatus=0 as not visible', () => {
    const stp = SAMPLE_STP.replace(
      'Strip.Curve.0.PlotStatus     1',
      'Strip.Curve.0.PlotStatus     0'
    );
    const result = convertStripTool(stp);
    expect(result.plots[0].traces[0].visible).toBe(false);
  });

  it('treats a suspicious 0/1 Max as unset (known writer bug) and warns', () => {
    const stp = SAMPLE_STP.replace(
      'Strip.Curve.0.Max            100.00',
      'Strip.Curve.0.Max            1'
    );
    const result = convertStripTool(stp);
    const axis0 = result.plots[0].axes[0];
    expect(axis0.max).toBeUndefined();
    expect(axis0.autoScale).toBe(true);
    expect(result.warnings.some((w) => w.includes('leaked Scale value'))).toBe(true);
  });

  it('rejects a file without the StripConfig header', () => {
    expect(() => convertStripTool('not a strip file\n')).toThrow(/StripConfig/);
  });

  it('rejects a file whose version is newer than this importer understands', () => {
    expect(() => convertStripTool('StripConfig                  2.0\n')).toThrow(/newer/);
  });
});
