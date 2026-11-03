// @vitest-environment jsdom
// Pins the pure gesture maths: stretches keep their anchor (the centre for
// extents), log axes keep ratios, and the pointer/wheel laws map pixels to
// their factors.
import { describe, expect, it } from 'vitest';
import {
  DELTA_LINE,
  DELTA_PAGE,
  DELTA_PIXEL,
  fromS,
  isPlotChrome,
  panExtentBy,
  roundExtent,
  stretchExtent,
  stretchFactorX,
  stretchFactorY,
  toS,
  wheelFactor,
  zoomExtentAt,
} from './geometry';

describe('toS / fromS', () => {
  it('is the identity on a linear axis', () => {
    expect(toS(42)).toBe(42);
    expect(fromS(42)).toBe(42);
    expect(toS(-3, false)).toBe(-3);
  });

  it('is log10 on a log axis and round-trips', () => {
    expect(toS(1000, true)).toBeCloseTo(3);
    expect(fromS(2, true)).toBeCloseTo(100);
    expect(fromS(toS(0.37, true), true)).toBeCloseTo(0.37);
  });
});

describe('stretchExtent', () => {
  it('preserves the centre on a linear axis', () => {
    const out = stretchExtent({ min: 10, max: 30 }, 2);
    expect((out.min + out.max) / 2).toBeCloseTo(20);
    expect(out.max - out.min).toBeCloseTo(40);
  });

  it('narrows with a factor below one', () => {
    const out = stretchExtent({ min: -4, max: 4 }, 0.5);
    expect(out).toEqual({ min: -2, max: 2 });
  });

  it('keeps ratios on a log axis (geometric centre preserved)', () => {
    const out = stretchExtent({ min: 1, max: 100 }, 2, true);
    expect(out.min).toBeCloseTo(0.1);
    expect(out.max).toBeCloseTo(1000);
    expect(Math.sqrt(out.min * out.max)).toBeCloseTo(10);
  });

  it('factor one is a no-op', () => {
    expect(stretchExtent({ min: 3, max: 7 }, 1)).toEqual({ min: 3, max: 7 });
  });
});

describe('zoomExtentAt', () => {
  it('keeps the anchor value fixed and its relative position', () => {
    const out = zoomExtentAt({ min: 0, max: 100 }, 25, 0.5);
    expect(out).toEqual({ min: 12.5, max: 62.5 });
    // 25 is still a quarter of the way up.
    expect((25 - out.min) / (out.max - out.min)).toBeCloseTo(0.25);
  });

  it('anchors in S space on a log axis', () => {
    // Zoom about 10 (S = 1) on 1..1000 (S 0..3) by 2 → S -1..5.
    const out = zoomExtentAt({ min: 1, max: 1000 }, 1, 2, true);
    expect(out.min).toBeCloseTo(0.1);
    expect(out.max).toBeCloseTo(100000);
  });
});

describe('panExtentBy', () => {
  it('shifts a linear extent additively', () => {
    expect(panExtentBy({ min: 1, max: 5 }, 2)).toEqual({ min: 3, max: 7 });
  });

  it('shifts a log extent multiplicatively, keeping its ratio', () => {
    const out = panExtentBy({ min: 1, max: 100 }, 1, true);
    expect(out.min).toBeCloseTo(10);
    expect(out.max).toBeCloseTo(1000);
    expect(out.max / out.min).toBeCloseTo(100);
  });
});

describe('pointer laws', () => {
  it('a 100 px upward drag gives 2^-0.5 on the Y band', () => {
    expect(stretchFactorY(-100)).toBeCloseTo(2 ** -0.5);
  });

  it('a 200 px downward drag doubles the Y extent', () => {
    expect(stretchFactorY(200)).toBeCloseTo(2);
    expect(stretchFactorY(0)).toBe(1);
  });

  it('dragging right narrows the time window, left widens it', () => {
    expect(stretchFactorX(200)).toBeCloseTo(0.5);
    expect(stretchFactorX(-200)).toBeCloseTo(2);
    expect(stretchFactorX(0)).toBe(1);
  });
});

describe('wheelFactor', () => {
  it('follows 2 ** (deltaY / 300) for pixel deltas', () => {
    expect(wheelFactor(100, DELTA_PIXEL)).toBeCloseTo(2 ** (100 / 300));
    expect(wheelFactor(-60)).toBeCloseTo(2 ** (-60 / 300));
    expect(wheelFactor(0)).toBe(1);
  });

  it('a 4 px delta zooms far less than a 100 px delta', () => {
    const small = Math.abs(Math.log2(wheelFactor(4)));
    const big = Math.abs(Math.log2(wheelFactor(100)));
    expect(small).toBeLessThan(big / 10);
  });

  it('clamps each event to [2^-0.5, 2^0.5]', () => {
    expect(wheelFactor(10_000)).toBeCloseTo(2 ** 0.5);
    expect(wheelFactor(-10_000)).toBeCloseTo(2 ** -0.5);
  });

  it('normalizes line and page modes to pixels before applying the law', () => {
    // One line is more than one pixel; one page saturates the clamp.
    expect(wheelFactor(1, DELTA_LINE)).toBeGreaterThan(wheelFactor(1, DELTA_PIXEL));
    expect(wheelFactor(1, DELTA_LINE)).toBeLessThanOrEqual(2 ** 0.5);
    expect(wheelFactor(1, DELTA_PAGE)).toBeCloseTo(2 ** 0.5);
    expect(wheelFactor(-1, DELTA_PAGE)).toBeCloseTo(2 ** -0.5);
  });

  it('returns 1 for a non-finite delta', () => {
    expect(wheelFactor(Number.NaN)).toBe(1);
  });
});

describe('isPlotChrome', () => {
  function mount(html: string): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-plot-id', 'p1');
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }

  it.each(['data-axis-badge', 'data-drawing-rail', 'data-status-line'])(
    'matches an element inside [%s]',
    (attr) => {
      const root = mount(`<div ${attr}><button><span id="inner">A</span></button></div>`);
      const inner = root.querySelector('#inner')!;
      expect(isPlotChrome(inner)).toBe(true);
      expect(isPlotChrome(inner.parentElement)).toBe(true);
      root.remove();
    }
  );

  it.each(['data-drawing-style'])('matches an element inside [%s]', (attr) => {
    const root = mount(
      `<div ${attr}><button data-style-chip><svg id="inner"></svg></button></div>`
    );
    expect(isPlotChrome(root.querySelector('#inner'))).toBe(true);
    root.remove();
  });

  it('matches an element inside the plot readout', () => {
    const root = mount('<div class="plot-readout"><span id="inner">Δt</span></div>');
    expect(isPlotChrome(root.querySelector('#inner'))).toBe(true);
    root.remove();
  });

  it('does not match the plot root or plain content', () => {
    const root = mount('<canvas id="c"></canvas>');
    expect(isPlotChrome(root)).toBe(false);
    expect(isPlotChrome(root.querySelector('#c'))).toBe(false);
    root.remove();
  });

  it('is false for null, undefined, text nodes and the window', () => {
    expect(isPlotChrome(null)).toBe(false);
    expect(isPlotChrome(undefined)).toBe(false);
    expect(isPlotChrome(document.createTextNode('x'))).toBe(false);
    expect(isPlotChrome(window)).toBe(false);
  });
});

describe('roundExtent', () => {
  it('rounds each bound to four significant digits of the span', () => {
    expect(roundExtent({ min: -0.6063454759106932, max: 5.696827262044653 })).toEqual({
      min: -0.606,
      max: 5.697,
    });
    expect(roundExtent({ min: 1000.123456, max: 1000.987654 })).toEqual({
      min: 1000.1235,
      max: 1000.9877,
    });
  });

  it('rounds a log axis bound relative to itself; leaves a degenerate extent alone', () => {
    expect(roundExtent({ min: 0.000123456, max: 98765.4 }, true)).toEqual({
      min: 0.0001235,
      max: 98770,
    });
    expect(roundExtent({ min: 2, max: 2 })).toEqual({ min: 2, max: 2 });
  });
});
