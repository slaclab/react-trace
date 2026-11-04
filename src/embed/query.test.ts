import { describe, it, expect, vi, afterEach } from 'vitest';
import { MAX_QUERY_BYTES, parseTraceQuery, serializeTraceQuery } from './query';

const PRESET =
  'pv=TEST:DIAG:BPM:01:POSITION:X&pv=TEST:DIAG:BPM:02:POSITION:X&pv=TEST:DIAG:BPM:03:POSITION:X&range=-1h';

const bytes = (s: string) => new TextEncoder().encode(s).length;

function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function roundTrip(x: string) {
  const once = parseTraceQuery(x);
  const again = parseTraceQuery(serializeTraceQuery(once.pvs, once.xAxis));
  expect(again).toEqual(once);
  return once;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTraceQuery', () => {
  it('parses the preset literal', () => {
    const warn = silenceWarn();
    expect(parseTraceQuery(PRESET)).toEqual({
      pvs: [
        'TEST:DIAG:BPM:01:POSITION:X',
        'TEST:DIAG:BPM:02:POSITION:X',
        'TEST:DIAG:BPM:03:POSITION:X',
      ],
      xAxis: { timeRange: '-1h' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('serializes the preset back to the identical literal', () => {
    const q = parseTraceQuery(PRESET);
    expect(serializeTraceQuery(q.pvs, q.xAxis)).toBe(PRESET);
  });

  it('tolerates a leading "?"', () => {
    expect(parseTraceQuery(`?${PRESET}`)).toEqual(parseTraceQuery(PRESET));
  });

  it('decodes URL-encoded PV names', () => {
    expect(parseTraceQuery('pv=A%20B%26C&pv=D%3DE&range=-4h').pvs).toEqual(['A B&C', 'D=E']);
  });

  it('accepts any relative range resolveTimeWindow understands', () => {
    for (const r of ['-30m', '-1.5h', '-2d', '-1w', '-1M']) {
      expect(parseTraceQuery(`pv=A&range=${encodeURIComponent(r)}`).xAxis).toEqual({
        timeRange: r,
      });
    }
  });

  it('skips empty and whitespace PV names', () => {
    expect(parseTraceQuery('pv=&pv=%20%20&pv=A&pv=+&range=-1h').pvs).toEqual(['A']);
  });

  it('defaults a missing range to -1h without warning', () => {
    const warn = silenceWarn();
    expect(parseTraceQuery('pv=A')).toEqual({ pvs: ['A'], xAxis: { timeRange: '-1h' } });
    expect(parseTraceQuery('')).toEqual({ pvs: [], xAxis: { timeRange: '-1h' } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a custom window with from and to verbatim', () => {
    const q = parseTraceQuery('pv=A&range=custom&from=2026-09-30T10:00&to=2026-09-30T11:30');
    expect(q.xAxis).toEqual({
      timeRange: 'custom',
      timeFrom: '2026-09-30T10:00',
      timeTo: '2026-09-30T11:30',
    });
  });

  it('reads a custom window without to as "until now"', () => {
    const q = parseTraceQuery('pv=A&range=custom&from=2026-09-30T10:00');
    expect(q.xAxis).toEqual({ timeRange: 'custom', timeFrom: '2026-09-30T10:00' });
    expect('timeTo' in q.xAxis).toBe(false);
  });

  it('treats an empty to as absent', () => {
    const q = parseTraceQuery('range=custom&from=2026-09-30T10:00&to=');
    expect(q.xAxis).toEqual({ timeRange: 'custom', timeFrom: '2026-09-30T10:00' });
  });

  it('ignores from/to on a relative range', () => {
    expect(parseTraceQuery('range=-4h&from=2026-09-30T10:00').xAxis).toEqual({ timeRange: '-4h' });
  });

  it.each([
    ['unknown preset', 'pv=A&range=yesterday'],
    ['missing minus', 'pv=A&range=1h'],
    ['empty range', 'pv=A&range='],
    ['custom without from', 'pv=A&range=custom'],
    ['custom with unparsable from', 'pv=A&range=custom&from=soon'],
    ['custom with a zone', 'pv=A&range=custom&from=2026-09-30T10:00Z'],
    ['custom with unparsable to', 'pv=A&range=custom&from=2026-09-30T10:00&to=later'],
    ['custom with from after to', 'pv=A&range=custom&from=2026-09-30T12:00&to=2026-09-30T11:00'],
  ])('bad range (%s) warns once and yields -1h', (_label, q) => {
    const warn = silenceWarn();
    const parsed = parseTraceQuery(q);
    expect(parsed.xAxis).toEqual({ timeRange: '-1h' });
    expect(parsed.pvs).toEqual(['A']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a query over 4 KB', () => {
    const warn = silenceWarn();
    const many = Array.from(
      { length: 400 },
      (_, i) => `pv=TEST:BPM:${String(i).padStart(3, '0')}:X`
    ).join('&');
    const q = `${many}&range=-4h`;
    expect(bytes(q)).toBeGreaterThan(MAX_QUERY_BYTES);
    expect(parseTraceQuery(q)).toEqual({ pvs: [], xAxis: { timeRange: '-1h' } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts a query of exactly 4 KB', () => {
    const head = 'pv=';
    const tail = '&range=-1h';
    const name = 'X'.repeat(MAX_QUERY_BYTES - head.length - tail.length);
    const q = `${head}${name}${tail}`;
    expect(bytes(q)).toBe(MAX_QUERY_BYTES);
    expect(parseTraceQuery(q).pvs).toEqual([name]);
  });
});

describe('serializeTraceQuery', () => {
  it('writes repeated pv then range, URL-encoded, no leading "?"', () => {
    const s = serializeTraceQuery(['A B', 'C&D'], { timeRange: '-4h' });
    expect(s).toBe('pv=A%20B&pv=C%26D&range=-4h');
    expect(s.startsWith('?')).toBe(false);
  });

  it('accepts PV traces and drops formula traces and blank names', () => {
    const s = serializeTraceQuery(
      [
        { kind: 'pv', pvName: 'A' },
        { kind: 'formula', pvName: 'A*2' },
        { pvName: 'B' },
        { kind: 'pv', pvName: '   ' },
        { kind: 'pv', pvName: '' },
      ],
      { timeRange: '-1d' }
    );
    expect(s).toBe('pv=A&pv=B&range=-1d');
  });

  it('writes a custom window with from and to', () => {
    expect(
      serializeTraceQuery(['A'], {
        timeRange: 'custom',
        timeFrom: '2026-09-30T10:00',
        timeTo: '2026-09-30T11:30',
      })
    ).toBe('pv=A&range=custom&from=2026-09-30T10:00&to=2026-09-30T11:30');
  });

  it('omits to when the custom window runs until now', () => {
    expect(
      serializeTraceQuery(['A'], { timeRange: 'custom', timeFrom: '2026-09-30T10:00', timeTo: '' })
    ).toBe('pv=A&range=custom&from=2026-09-30T10:00');
  });

  it('ignores from/to on a relative range', () => {
    expect(serializeTraceQuery(['A'], { timeRange: '-2d', timeFrom: '2026-09-30T10:00' })).toBe(
      'pv=A&range=-2d'
    );
  });

  it('writes an invalid range as -1h with one warning', () => {
    const warn = silenceWarn();
    expect(serializeTraceQuery(['A'], { timeRange: 'custom' })).toBe('pv=A&range=-1h');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops trailing PVs with one warning until the query fits 4 KB', () => {
    const warn = silenceWarn();
    const pvs = Array.from({ length: 400 }, (_, i) => `TEST:BPM:${String(i).padStart(3, '0')}:X`);
    const s = serializeTraceQuery(pvs, { timeRange: '-4h' });
    expect(bytes(s)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(warn).toHaveBeenCalledTimes(1);
    const parsed = parseTraceQuery(s);
    expect(parsed.xAxis).toEqual({ timeRange: '-4h' });
    expect(parsed.pvs.length).toBeGreaterThan(0);
    expect(parsed.pvs).toEqual(pvs.slice(0, parsed.pvs.length));
    // Maximal: one more PV would not have fit.
    const oneMore = serializeTraceQuery(pvs.slice(0, parsed.pvs.length + 1), { timeRange: '-4h' });
    expect(parseTraceQuery(oneMore).pvs.length).toBe(parsed.pvs.length);
  });

  it('does not warn when the query fits', () => {
    const warn = silenceWarn();
    serializeTraceQuery(['A', 'B'], { timeRange: '-1h' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('round trip parse(serialize(parse(x))) === parse(x)', () => {
  it.each([
    ['preset', PRESET],
    ['custom with to', 'pv=A&pv=B&range=custom&from=2026-09-30T10:00&to=2026-09-30T11:30'],
    ['custom without to', 'pv=A&range=custom&from=2026-09-30T10:00'],
    ['custom with seconds', 'pv=A&range=custom&from=2026-09-30T10:00:15&to=2026-09-30T10:05:45'],
    ['encoded names', 'pv=A%20B%26C&pv=%E2%9C%93&range=-1.5h'],
    ['blanks skipped', 'pv=&pv=A&pv=%20&range=-30m'],
    ['no range', 'pv=A'],
    ['empty', ''],
    ['bad range', 'pv=A&range=bogus'],
  ])('%s', (_label, x) => {
    silenceWarn();
    roundTrip(x);
  });

  it('round-trips a custom window and keeps to absent', () => {
    const q = roundTrip('pv=A&range=custom&from=2026-09-30T10:00');
    expect(q.xAxis.timeTo).toBeUndefined();
  });
});

describe('the plot key', () => {
  const config = {
    v: 1,
    axes: [{}, { name: 'I', orientation: 'right' as const, logScale: true }],
    traces: [{}, { axis: 1, color: '#123456' }],
  };

  it('is absent from an old query, which still opens', () => {
    const warn = silenceWarn();
    expect(parseTraceQuery(PRESET).plot).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is read beside the PVs and range', () => {
    const q = serializeTraceQuery(['A', 'B'], { timeRange: '-6h' }, config);
    expect(q.startsWith('pv=A&pv=B&range=-6h&plot={')).toBe(true);
    expect(parseTraceQuery(q)).toEqual({
      pvs: ['A', 'B'],
      xAxis: { timeRange: '-6h' },
      plot: config,
    });
  });

  it('is read with no range and with an invalid range', () => {
    silenceWarn();
    const plot = encodeURIComponent(JSON.stringify(config));
    expect(parseTraceQuery(`pv=A&plot=${plot}`).plot).toEqual(config);
    expect(parseTraceQuery(`pv=A&range=bogus&plot=${plot}`).plot).toEqual(config);
  });

  it('is ignored with one warning when unreadable, keeping PVs and range', () => {
    const warn = silenceWarn();
    expect(parseTraceQuery('pv=A&range=-2h&plot=%7Bnope')).toEqual({
      pvs: ['A'],
      xAxis: { timeRange: '-2h' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('round-trips through parse(serialize(parse(x)))', () => {
    const q = serializeTraceQuery(['A', 'B'], { timeRange: '-1h' }, config);
    const once = parseTraceQuery(q);
    expect(parseTraceQuery(serializeTraceQuery(once.pvs, once.xAxis, once.plot))).toEqual(once);
  });

  it('shrinks to the axes, then goes, before any PV is dropped', () => {
    const warn = silenceWarn();
    const pvs = Array.from({ length: 30 }, (_, i) => `TEST:BPM:${String(i).padStart(3, '0')}:X`);
    const big = {
      v: 1,
      axes: [{}, { logScale: true }],
      traces: pvs.map((_, i) => ({ axis: i % 2, displayName: 'x'.repeat(150) })),
    };
    const s = serializeTraceQuery(pvs, { timeRange: '-1h' }, big);
    expect(bytes(s)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const parsed = parseTraceQuery(s);
    expect(parsed.pvs).toEqual(pvs);
    expect(parsed.plot?.axes).toEqual(big.axes);
    expect(parsed.plot?.traces?.[1]).toEqual({ axis: 1 });
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    const huge = { ...big, axes: Array.from({ length: 16 }, () => ({ name: 'n'.repeat(200) })) };
    const t = serializeTraceQuery(pvs, { timeRange: '-1h' }, huge);
    expect(parseTraceQuery(t)).toEqual({ pvs, xAxis: { timeRange: '-1h' } });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
