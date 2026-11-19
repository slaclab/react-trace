// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The composer is the canvas/Image pipeline (tested in annotations/capture);
// here only what it is handed and what its result becomes matter.
const compose = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'data:image/png;base64,COMPOSED')
);
vi.mock('../../plot/capture', () => ({ composeOverlayPng: compose }));

import {
  downloadWaveformCsv,
  downloadWaveformPng,
  waveformPngSource,
  waveformCsv,
  waveformFileName,
  type WaveformExport,
} from './export';

const A = 'SIM:WAVE:X';
const B = 'SIM:WAVE:Y';
const REF = 'SIM:WAVE:GOLDEN';
const XS = 'SIM:POS:S';
const T = Date.UTC(2026, 9, 14, 12, 30, 45, 123);

function f(...values: number[]): Float64Array {
  return Float64Array.from(values);
}

function input(over: Partial<WaveformExport> = {}): WaveformExport {
  return {
    time: T,
    curves: [
      { name: A, values: f(1, 2, 3, 4) },
      { name: B, values: f(10, NaN, 30, 40) },
    ],
    reference: null,
    x: null,
    range: null,
    delta: false,
    ...over,
  };
}

/** Rows without `#` comments: [header, ...data], each split into cells. */
function table(csv: string): string[][] {
  return csv
    .trim()
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .map((l) => l.split(','));
}

describe('waveformCsv column order', () => {
  it('writes element, then the drawn curves in order', () => {
    const rows = table(waveformCsv(input()));
    expect(rows[0]).toEqual(['element', A, B]);
    expect(rows.slice(1)).toEqual([
      ['0', '1', '10'],
      ['1', '2', ''],
      ['2', '3', '30'],
      ['3', '4', '40'],
    ]);
  });

  it('puts the X-source after element and the reference last', () => {
    const rows = table(
      waveformCsv(
        input({
          x: { name: XS, values: f(0.5, 1.5, 2.5, 3.5), usable: true },
          reference: { name: REF, values: f(9, 8, 7, 6) },
        })
      )
    );
    expect(rows[0]).toEqual(['element', XS, A, B, REF]);
    expect(rows[1]).toEqual(['0', '0.5', '1', '10', '9']);
    expect(rows[4]).toEqual(['3', '3.5', '4', '40', '6']);
  });

  it('marks curve columns as Δ when Δ is on, the reference column stays raw', () => {
    const rows = table(
      waveformCsv(input({ delta: true, reference: { name: REF, values: f(1, 1, 1, 1) } }))
    );
    expect(rows[0]).toEqual(['element', `Δ ${A}`, `Δ ${B}`, REF]);
    expect(waveformCsv(input({ delta: true }))).toMatch(/^# delta: on/m);
    expect(waveformCsv(input())).toMatch(/^# delta: off/m);
  });

  it('quotes a header that holds a comma or quote', () => {
    const rows = waveformCsv(input({ curves: [{ name: 'a,"b"', values: f(1) }] }))
      .split('\n')
      .filter((l) => !l.startsWith('#'));
    expect(rows[0]).toBe('element,"a,""b"""');
  });
});

describe('waveformCsv empty cells', () => {
  it('writes NaN and ±Infinity as empty cells', () => {
    const rows = table(
      waveformCsv(input({ curves: [{ name: A, values: f(NaN, Infinity, -Infinity, 0) }] }))
    );
    expect(rows.slice(1)).toEqual([
      ['0', ''],
      ['1', ''],
      ['2', ''],
      ['3', '0'],
    ]);
  });

  it('leaves cells empty past the end of a shorter column', () => {
    const rows = table(
      waveformCsv(
        input({
          curves: [
            { name: A, values: f(1, 2, 3) },
            { name: B, values: f(5) },
          ],
        })
      )
    );
    expect(rows.slice(1)).toEqual([
      ['0', '1', '5'],
      ['1', '2', ''],
      ['2', '3', ''],
    ]);
  });
});

describe('waveformCsv X-source column', () => {
  it('omits the X-source when it is not usable', () => {
    const rows = table(
      waveformCsv(input({ x: { name: XS, values: f(1, 2, 3, 4), usable: false } }))
    );
    expect(rows[0]).toEqual(['element', A, B]);
  });

  it('omits the X-source when it has no values', () => {
    const rows = table(waveformCsv(input({ x: { name: XS, values: null, usable: true } })));
    expect(rows[0]).toEqual(['element', A, B]);
  });
});

describe('waveformCsv element range', () => {
  it('exports only the inclusive element range', () => {
    const rows = table(waveformCsv(input({ range: { first: 1, last: 2 } })));
    expect(rows.slice(1)).toEqual([
      ['1', '2', ''],
      ['2', '3', '30'],
    ]);
    expect(waveformCsv(input({ range: { first: 1, last: 2 } }))).toMatch(/^# elements: 1\.\.2/m);
  });

  it('accepts an open-ended range and clamps past the frame', () => {
    const rows = table(waveformCsv(input({ range: { first: 2, last: 99 } })));
    expect(rows.slice(1).map((r) => r[0])).toEqual(['2', '3']);
  });

  it('writes only the header when there are no curves', () => {
    const rows = table(waveformCsv(input({ curves: [] })));
    expect(rows).toEqual([['element']]);
  });
});

describe('waveformFileName', () => {
  it('stamps the ISO time on the Correlation pattern', () => {
    expect(waveformFileName(T, 'csv')).toBe('waveform-2026-10-14T12-30-45-123Z.csv');
    expect(waveformFileName(T, 'png')).toBe('waveform-2026-10-14T12-30-45-123Z.png');
  });

  it('falls back to "empty" for an invalid time', () => {
    expect(waveformFileName(NaN, 'csv')).toBe('waveform-empty.csv');
  });
});

describe('downloads', () => {
  afterEach(() => vi.restoreAllMocks());

  function captureClicks(): { href: string; download: string }[] {
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    return clicks;
  }

  it('downloads the PNG through the chart data URL', () => {
    const clicks = captureClicks();
    const getDataURL = vi.fn(() => 'data:image/png;base64,AAAA');
    downloadWaveformPng({ getDataURL }, '#101010', T);
    expect(getDataURL).toHaveBeenCalledWith({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: '#101010',
    });
    expect(clicks).toEqual([
      { href: 'data:image/png;base64,AAAA', download: 'waveform-2026-10-14T12-30-45-123Z.png' },
    ]);
  });

  it('downloads the CSV as a blob URL', () => {
    const clicks = captureClicks();
    const create = vi.fn(() => 'blob:waveform');
    const revoke = vi.fn();
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    try {
      downloadWaveformCsv(input());
    } finally {
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual([
      { href: 'blob:waveform', download: 'waveform-2026-10-14T12-30-45-123Z.csv' },
    ]);
  });
});

describe('PNG with drawings', () => {
  const CHART_URL = 'data:image/png;base64,CHART';
  const OPTS = { type: 'png' as const, pixelRatio: 2, backgroundColor: '#161616' };

  afterEach(() => {
    vi.restoreAllMocks();
    compose.mockClear();
    document.body.innerHTML = '';
  });

  /** A stage holding the chart div and `layers` overlay svgs, as Plot.tsx mounts them. */
  function stage(layers: number): { dom: HTMLElement; svgs: SVGSVGElement[] } {
    const root = document.createElement('div');
    root.className = 'waveform-plot__stage';
    const dom = document.createElement('div');
    root.appendChild(dom);
    const svgs: SVGSVGElement[] = [];
    for (let i = 0; i < layers; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('data-annotation-layer', '');
      root.appendChild(svg);
      svgs.push(svg);
    }
    // A non-overlay svg (e.g. an icon) is not composed.
    root.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    document.body.appendChild(root);
    return { dom, svgs };
  }

  function chart(dom: HTMLElement | null, url = CHART_URL) {
    return {
      getDataURL: vi.fn(() => url),
      getWidth: () => 640,
      getHeight: () => 400,
      getDom: () => dom,
    };
  }

  function captureClicks(): { href: string; download: string }[] {
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    return clicks;
  }

  it('composes every overlay of the chart stage over the chart', async () => {
    const { dom, svgs } = stage(2);
    const c = chart(dom);
    const result = waveformPngSource(c, false).getDataURL(OPTS);
    expect(typeof result).not.toBe('string');
    await expect(result).resolves.toBe('data:image/png;base64,COMPOSED');
    expect(c.getDataURL).toHaveBeenCalledWith(OPTS);
    expect(compose).toHaveBeenCalledWith(CHART_URL, svgs, '#161616', {
      width: 640,
      height: 400,
      pixelRatio: 2,
    });
  });

  it('exports the chart alone when drawings are hidden', () => {
    const { dom } = stage(1);
    const result = waveformPngSource(chart(dom), true).getDataURL(OPTS);
    expect(result).toBe(CHART_URL);
    expect(compose).not.toHaveBeenCalled();
  });

  it('stays synchronous with no overlay in the stage', () => {
    const { dom } = stage(0);
    expect(waveformPngSource(chart(dom), false).getDataURL(OPTS)).toBe(CHART_URL);
    expect(compose).not.toHaveBeenCalled();
  });

  it('treats a chart without a DOM root (a test double) as having no overlays', () => {
    const plain = { getDataURL: vi.fn(() => CHART_URL) };
    expect(waveformPngSource(plain, false).getDataURL(OPTS)).toBe(CHART_URL);
    expect(waveformPngSource(chart(null), false).getDataURL(OPTS)).toBe(CHART_URL);
    expect(compose).not.toHaveBeenCalled();
  });

  it('does not compose a chart URL that is not a data URL', () => {
    const { dom } = stage(1);
    expect(waveformPngSource(chart(dom, ''), false).getDataURL(OPTS)).toBe('');
    expect(compose).not.toHaveBeenCalled();
  });

  it('falls back to the chart alone when composing fails', async () => {
    const { dom } = stage(1);
    compose.mockRejectedValueOnce(new Error('decode'));
    await expect(waveformPngSource(chart(dom), false).getDataURL(OPTS)).resolves.toBe(CHART_URL);
  });

  it('downloads the composed PNG once it resolves', async () => {
    const clicks = captureClicks();
    const { dom } = stage(1);
    downloadWaveformPng(chart(dom), '#161616', T);
    expect(clicks).toEqual([]);
    await vi.waitFor(() => expect(clicks.length).toBe(1));
    expect(clicks[0]).toEqual({
      href: 'data:image/png;base64,COMPOSED',
      download: 'waveform-2026-10-14T12-30-45-123Z.png',
    });
  });

  it('downloads the chart alone, synchronously, when drawings are hidden', () => {
    const clicks = captureClicks();
    const { dom } = stage(1);
    downloadWaveformPng(chart(dom), '#161616', T, true);
    expect(clicks).toEqual([
      { href: CHART_URL, download: 'waveform-2026-10-14T12-30-45-123Z.png' },
    ]);
    expect(compose).not.toHaveBeenCalled();
  });
});
