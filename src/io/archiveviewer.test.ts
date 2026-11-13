// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { convertArchiveViewer, decodeArchiveViewerXml } from './archiveviewer';
import { extractFormulaVars, resolveFormulaSpec } from '../formula';

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

    // ArchiveViewer's bare "A+B" term is braced into Fox's {var} placeholder
    // syntax (src/formula.ts's extractFormulaVars only recognizes braces) for
    // each variable with an argument_ave — this fixture only declares "A".
    expect(formula.expression).toBe('{A}+B');
    expect(formula.bindings).toEqual({ A: pv.id });
    expect(formula.lineType).toBe('step');
    // -65536 & 0xffffff == 0xff0000
    expect(formula.color).toBe('#ff0000');

    // formula's range_axis_name is empty → plotted on the shared raw-value axis, not the named axis.
    expect(formula.axisId).not.toBe(pv.axisId);
    const sharedAxis = plot.axes.find((a) => a.id === formula.axisId)!;
    expect(sharedAxis.name).toBe('Shared (raw values)');

    const namedAxis = plot.axes.find((a) => a.id === pv.axisId)!;
    expect(namedAxis.name).toBe('Main Range Axis');
    expect(namedAxis.autoScale).toBe(true);

    expect(result.warnings.some((w) => w.includes('MyArchiveDirectory'))).toBe(true);
  });

  it('resolves a relative start paired with a fixed absolute end (not "now")', () => {
    // A real-world combination: relative start (short enough that "now minus
    // start" still lands after the fixed end), explicit MM/dd/yyyy end.
    const nearFutureEnd = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const avDate =
      `${pad(nearFutureEnd.getMonth() + 1)}/${pad(nearFutureEnd.getDate())}/${nearFutureEnd.getFullYear()}` +
      ` ${pad(nearFutureEnd.getHours())}:${pad(nearFutureEnd.getMinutes())}:${pad(nearFutureEnd.getSeconds())}`;
    const xml = SAMPLE_XML.replace('<start>-1d</start>', '<start>-1s</start>').replace(
      '<end>now</end>',
      `<end>${avDate}</end>`
    );
    const result = convertArchiveViewer(xml);
    const xAxis = result.plots[0].xAxis;
    expect(xAxis.timeRange).toBe('custom');
    expect(xAxis.timeFrom).toBeDefined();
    expect(xAxis.timeTo).toBeDefined();
    // No "not understood" fallback warning for this combination.
    expect(result.warnings.some((w) => w.includes('not understood'))).toBe(false);
  });

  it('falls back to the last hour, with a warning, when the relative start (from now) is not before the fixed end', () => {
    // A relative start is resolved against *now*, not the fixed end, so a
    // saved end far enough in the past produces a reversed range.
    const xml = SAMPLE_XML.replace('<end>now</end>', '<end>07/11/2024 08:15:45</end>');
    const result = convertArchiveViewer(xml);
    const xAxis = result.plots[0].xAxis;
    expect(xAxis).toEqual({ timeRange: '-1h' });
    expect(result.warnings.some((w) => w.includes('is not before fixed end'))).toBe(true);
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

  it('resolves a formula end to end from a real exported file (issue: formulas never evaluated)', () => {
    // A bare "A+B" term matched against <argument_ave variable="A"/|"B"/> — the
    // real-world shape that exposed resolveFormulaSpec returning null forever,
    // because extractFormulaVars only recognizes brace-delimited placeholders.
    const xml = `<AVConfiguration>
  <pv name="SIOC:SYS0:ML00:AO001" directory_name="MainArchive">
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name>Main Range Axis</range_axis_name>
    <color>-16776961</color>
    <draw_type>lines</draw_type>
    <draw_width>1.0</draw_width>
    <visibility>true</visibility>
  </pv>
  <pv name="BPMS:LI21:233:X" directory_name="MainArchive">
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name>Main Range Axis</range_axis_name>
    <color>-65536</color>
    <draw_type>scatter</draw_type>
    <draw_width>2.0</draw_width>
    <visibility>true</visibility>
  </pv>
  <formula name="SUM_OF_PVS" directory_name="MainArchive">
    <term>A+B</term>
    <argument_ave name="SIOC:SYS0:ML00:AO001" variable="A"/>
    <argument_ave name="BPMS:LI21:233:X" variable="B"/>
    <method_name>average</method_name>
    <nr_values>800</nr_values>
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name></range_axis_name>
    <color>-16711936</color>
    <draw_type>steps</draw_type>
    <draw_width>1.0</draw_width>
    <visibility>false</visibility>
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
  <plot_title>Sample Save File</plot_title>
</AVConfiguration>`;
    const result = convertArchiveViewer(xml);
    const traces = result.plots[0].traces;
    const a = traces.find((t) => t.pvName === 'SIOC:SYS0:ML00:AO001')!;
    const b = traces.find((t) => t.pvName === 'BPMS:LI21:233:X')!;
    const formula = traces.find((t) => t.kind === 'formula')!;

    expect(formula.expression).toBe('{A}+{B}');
    expect(formula.bindings).toEqual({ A: a.id, B: b.id });
    // Surfaced for traceLabel (formulas have no pvName to fall back to), so
    // the layer tree shows "SUM_OF_PVS" rather than a numbered placeholder.
    expect(formula.displayName).toBe('SUM_OF_PVS');
    expect(extractFormulaVars(formula.expression!)).toEqual(['A', 'B']);
    expect(resolveFormulaSpec(formula, traces)).toEqual({
      kind: 'timeseries',
      expression: '{A}+{B}',
      bindings: { A: 'SIOC:SYS0:ML00:AO001', B: 'BPMS:LI21:233:X' },
    });
  });

  it('braces the longer variable name first so one is not split by the other (e.g. "A" inside "AB")', () => {
    const xml = `<AVConfiguration>
  <pv name="PV1" directory_name="Default">
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name>Main Range Axis</range_axis_name>
    <color>-1</color>
    <draw_type>lines</draw_type>
    <draw_width>1.0</draw_width>
    <visibility>true</visibility>
  </pv>
  <pv name="PV2" directory_name="Default">
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name>Main Range Axis</range_axis_name>
    <color>-1</color>
    <draw_type>lines</draw_type>
    <draw_width>1.0</draw_width>
    <visibility>true</visibility>
  </pv>
  <formula name="F" directory_name="Default">
    <term>AB+A</term>
    <argument_ave name="PV1" variable="AB"/>
    <argument_ave name="PV2" variable="A"/>
    <method_name>average</method_name>
    <nr_values>800</nr_values>
    <time_axis_name>Main Time Axis</time_axis_name>
    <range_axis_name></range_axis_name>
    <color>-1</color>
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
  <plot_title></plot_title>
</AVConfiguration>`;
    const result = convertArchiveViewer(xml);
    const formula = result.plots[0].traces.find((t) => t.kind === 'formula')!;
    expect(formula.expression).toBe('{AB}+{A}');
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
