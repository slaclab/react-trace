// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { convertArchiveViewer, decodeArchiveViewerXml } from './archiveviewer';

// Mirrors the reconstructed sample in ARCHIVEVIEWER_XML_FORMAT.md, minus the
// XML prolog (DOMParser doesn't need it for this test's purposes).
const SAMPLE_XML = `<AVConfiguration>
  <connection_parameter>some-archiver-connection-string</connection_parameter>
  <pv name="MY:PV:NAME" directory_name="MyArchiveDirectory">
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name>Main Range Axis</range_axis_name>
    <color>-16776961</color>
    <draw_type>lines</draw_type>
    <draw_width>1.0</draw_width>
    <visibility>true</visibility>
  </pv>
  <formula name="MY:FORMULA" directory_name="MyArchiveDirectory">
    <term>A+B</term>
    <argument_ave name="MY:PV:NAME" variable="A"/>
    <method_name>average</method_name>
    <nr_values>800</nr_values>
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name></range_axis_name>
    <color>-65536</color>
    <draw_type>steps</draw_type>
    <draw_width>1.0</draw_width>
    <visibility>true</visibility>
  </formula>
  <time_axis name="Main Time Axis">
    <start>-1d</start>
    <end>now</end>
    <location>bottom</location>
  </time_axis>
  <range_axis name="Main Range Axis">
    <min></min>
    <max></max>
    <type>normal</type>
    <location>left</location>
  </range_axis>
  <legend_configuration show_ave_name="true" show_directory_name="true" show_range="true" show_units="true"></legend_configuration>
  <plot_title>My Plot</plot_title>
</AVConfiguration>
`;

describe('convertArchiveViewer', () => {
  it('imports pv and formula traces, axes, and the time range', () => {
    const result = convertArchiveViewer(SAMPLE_XML);
    expect(result.source).toBe('archiveviewer');
    const plot = result.plots[0];

    expect(plot.title).toBe('My Plot');
    expect(plot.xAxis).toEqual({ timeRange: '-1d' });

    expect(plot.traces).toHaveLength(2);
    const pv = plot.traces.find((t) => t.kind === 'pv')!;
    const formula = plot.traces.find((t) => t.kind === 'formula')!;

    expect(pv.pvName).toBe('MY:PV:NAME');
    // -16776961 & 0xffffff == 0x0000ff
    expect(pv.color).toBe('#0000ff');
    expect(pv.lineType).toBe('direct');
    expect(pv.useArchive).toBe(true);
    expect(pv.useLive).toBe(false);

    expect(formula.expression).toBe('A+B');
    expect(formula.bindings).toEqual({ A: pv.id });
    expect(formula.lineType).toBe('step');
    // -65536 & 0xffffff == 0xff0000
    expect(formula.color).toBe('#ff0000');

    // formula's range_axis_name is empty → plotted normalized, not the named axis.
    expect(formula.axisId).not.toBe(pv.axisId);
    const normalizedAxis = plot.axes.find((a) => a.id === formula.axisId)!;
    expect(normalizedAxis.name).toBe('Normalized');

    const namedAxis = plot.axes.find((a) => a.id === pv.axisId)!;
    expect(namedAxis.name).toBe('Main Range Axis');
    expect(namedAxis.autoScale).toBe(true);

    expect(result.warnings.some((w) => w.includes('MyArchiveDirectory'))).toBe(true);
  });

  it('resolves a relative start paired with a fixed absolute end (not "now")', () => {
    // A real-world combination: relative start, explicit MM/dd/yyyy end.
    const xml = SAMPLE_XML.replace('<end>now</end>', '<end>07/11/2024 08:15:45</end>');
    const result = convertArchiveViewer(xml);
    const xAxis = result.plots[0].xAxis;
    expect(xAxis.timeRange).toBe('custom');
    expect(xAxis.timeTo).toBe('2024-07-11T08:15');
    expect(xAxis.timeFrom).toBeDefined();
    // No "not understood" fallback warning for this combination.
    expect(result.warnings.some((w) => w.includes('not understood'))).toBe(false);
  });

  it('warns and drops extra time axes, keeping only the first', () => {
    const xmlWithTwoTimeAxes = SAMPLE_XML.replace(
      '<range_axis name="Main Range Axis">',
      `<time_axis name="Secondary Time Axis">
        <start>-2d</start>
        <end>now</end>
        <location></location>
      </time_axis>
      <range_axis name="Main Range Axis">`
    );
    const result = convertArchiveViewer(xmlWithTwoTimeAxes);
    expect(result.plots[0].xAxis).toEqual({ timeRange: '-1d' });
    expect(result.warnings.some((w) => w.includes('Secondary Time Axis'))).toBe(true);
  });

  it('warns when a formula argument cannot be resolved', () => {
    const xml = SAMPLE_XML.replace(
      'name="MY:PV:NAME" variable="A"',
      'name="NOT:A:TRACE" variable="A"'
    );
    const result = convertArchiveViewer(xml);
    expect(result.warnings.some((w) => w.includes('could not bind'))).toBe(true);
    const formula = result.plots[0].traces.find((t) => t.kind === 'formula')!;
    expect(formula.bindings).toEqual({});
  });

  it('rejects malformed XML', () => {
    expect(() => convertArchiveViewer('<AVConfiguration><pv></AVConfiguration>')).toThrow();
  });

  it('rejects a document missing the AVConfiguration root', () => {
    expect(() => convertArchiveViewer('<nope></nope>')).toThrow(/AVConfiguration/);
  });
});

describe('decodeArchiveViewerXml', () => {
  it('decodes a UTF-16LE buffer with a BOM', () => {
    const text = '<?xml version="1.0" encoding="UTF-16" ?><a>hi</a>';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[2 + i * 2] = code & 0xff;
      bytes[2 + i * 2 + 1] = code >> 8;
    }
    expect(decodeArchiveViewerXml(bytes.buffer)).toBe(text);
  });

  it('falls back to UTF-8 when there is no UTF-16 marker', () => {
    const text = '<a>hi</a>';
    const bytes = new TextEncoder().encode(text);
    expect(decodeArchiveViewerXml(bytes.buffer)).toBe(text);
  });

  it('decodes as UTF-8 when the file is plain ASCII despite a UTF-16 declaration and no BOM', () => {
    // A real-world case: a file re-saved/hand-edited as plain text kept the
    // original <?xml ... encoding="UTF-16"?> declaration but its bytes are
    // actually ASCII — the declaration text must not be trusted over the
    // byte pattern.
    const text = '<?xml version="1.0" encoding="UTF-16"?><a>hi</a>';
    const bytes = new TextEncoder().encode(text);
    expect(decodeArchiveViewerXml(bytes.buffer)).toBe(text);
  });
});
