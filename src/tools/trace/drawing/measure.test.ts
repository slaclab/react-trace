// @vitest-environment jsdom
// Pins the measure readout: Δy / Δ% / Δt from the two anchors, n / mean / σ over the
// adopted curve's samples inside [t0, t1] through the shared statistics
// library, the adopted-curve rule, the binned wording, and the card the
// overlay draws for persisted and draft measures.
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinePoint } from '../../../components/traceGaps';
import { drawingThemeFor } from '../../../annotationTheme';
import { AnnotationLayer } from '../../../annotations/AnnotationLayer';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { type Annotation, objNameIn } from '../../../annotations/model';
import type { AxisRef } from '../../../annotations/catalog/types';
import { TERM_GAP } from '../../../annotations/catalog/format';
import {
  adoptedTraceId,
  measureCardLines,
  measureLabel,
  measureReadout,
  type MeasureInputs,
} from './measure';
import { BUILTIN_CATALOG } from '../../../annotations/catalog';
import { TIME_X_AXIS } from '../../../annotations/catalog/xAxis';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

function measure(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'm1',
    kind: 'measure',
    points: [
      { t: 1000, v: 10 },
      { t: 5000, v: 15 },
    ],
    axisId: 'a',
    color: '#4589ff',
    width: 1.5,
    text: '',
    ...over,
  };
}

/** Samples every 1000 ms from 0 to 9000 with value(t). */
function line(value: (t: number) => number | null, from = 0, to = 9000): LinePoint[] {
  const out: LinePoint[] = [];
  for (let t = from; t <= to; t += 1000) out.push([t, value(t)]);
  return out;
}

/** One readout line: its terms, spaced as the readout spaces them. */
const ln = (...parts: string[]) => parts.join(TERM_GAP);

const RAW: MeasureInputs = {
  traceData: new Map([['c1', line((t) => t / 1000)]]),
  traces: [{ id: 'c1', axisId: 'a' }],
  primaryAxisId: 'a',
};

describe('measureReadout: deltas', () => {
  it('reports Δy, Δ% vs the first point and Δt from the anchors', () => {
    const r = measureReadout(measure(), RAW);
    expect(r.dy).toBe(5);
    expect(r.dPct).toBeCloseTo(50);
    expect(r.dt).toBe(4000);
  });

  it('has no Δ% when v0 is 0', () => {
    const a = measure({
      points: [
        { t: 1000, v: 0 },
        { t: 5000, v: 3 },
      ],
    });
    const r = measureReadout(a, RAW);
    expect(r.dPct).toBeNull();
    // No percentage term at all.
    expect(measureCardLines(r)[0]).toBe(ln('Δt = 4 s', 'Δy = 3'));
  });

  it('has no Δ% when v0 is not finite', () => {
    const a = measure({
      points: [
        { t: 1000, v: Number.NaN },
        { t: 5000, v: 3 },
      ],
    });
    expect(measureReadout(a, RAW).dPct).toBeNull();
  });

  it('reports a negative Δ% for a drop, relative to |v0|', () => {
    const a = measure({
      points: [
        { t: 1000, v: -10 },
        { t: 5000, v: -15 },
      ],
    });
    expect(measureReadout(a, RAW).dPct).toBeCloseTo(-50);
  });
});

describe('measureReadout: statistics over the adopted curve', () => {
  it('computes n, mean and sample σ over the samples inside [t0, t1]', () => {
    // Samples at 1000..5000 inclusive: values 1, 2, 3, 4, 5.
    const r = measureReadout(measure(), RAW);
    expect(r.traceId).toBe('c1');
    expect(r.n).toBe(5);
    expect(r.mean).toBeCloseTo(3);
    expect(r.std).toBeCloseTo(Math.sqrt(2.5)); // ddof = 1
    expect(r.binned).toBe(false);
  });

  it('slices the same span when the anchors run right to left', () => {
    const a = measure({
      points: [
        { t: 5000, v: 15 },
        { t: 1000, v: 10 },
      ],
    });
    const r = measureReadout(a, RAW);
    expect(r.n).toBe(5);
    expect(r.mean).toBeCloseTo(3);
    expect(r.dt).toBe(-4000);
  });

  it('skips gap markers in the span', () => {
    const data = new Map([['c1', line((t) => (t === 3000 ? null : t / 1000))]]);
    const r = measureReadout(measure(), { ...RAW, traceData: data });
    expect(r.n).toBe(4);
    expect(r.mean).toBeCloseTo((1 + 2 + 4 + 5) / 4);
  });

  it('reads n = 0 and no mean / σ for a span with no sample', () => {
    const a = measure({
      points: [
        { t: 1200, v: 1 },
        { t: 1800, v: 2 },
      ],
    });
    const r = measureReadout(a, RAW);
    expect(r.traceId).toBe('c1');
    expect(r.n).toBe(0);
    expect(r.mean).toBeNull();
    expect(r.std).toBeNull();
    expect(measureCardLines(r)[1]).toBe(ln('n = 0', 'x̄ = —', 'σ = —'));
  });

  it('adopts the snapped traceId over the nearest curve', () => {
    const inputs: MeasureInputs = {
      traceData: new Map([
        ['near', line(() => 1)],
        ['snapped', line(() => 7, 0, 3000)],
      ]),
      traces: [
        { id: 'near', axisId: 'a' },
        { id: 'snapped', axisId: 'b' },
      ],
      primaryAxisId: 'a',
    };
    const r = measureReadout(measure({ traceId: 'snapped' }), inputs);
    expect(r.traceId).toBe('snapped');
    expect(r.n).toBe(3); // 1000, 2000, 3000
    expect(r.mean).toBe(7);
  });

  it('falls back to the nearest primary-axis curve when the snapped one has no data', () => {
    const r = measureReadout(measure({ traceId: 'gone' }), RAW);
    expect(r.traceId).toBe('c1');
  });

  it('adopts the primary-axis curve nearest in time, never one on another axis', () => {
    const inputs: MeasureInputs = {
      traceData: new Map([
        ['far', line(() => 1, 20_000, 30_000)],
        ['near', line(() => 2, 6000, 9000)],
        ['other', line(() => 3)], // covers the span, but on axis b
      ]),
      traces: [
        { id: 'far', axisId: 'a' },
        { id: 'near', axisId: 'a' },
        { id: 'other', axisId: 'b' },
      ],
      primaryAxisId: 'a',
    };
    expect(adoptedTraceId(measure(), inputs)).toBe('near');
    const r = measureReadout(measure(), inputs);
    expect(r.n).toBe(0);
  });

  it('prefers a curve with samples inside the span; ties keep the earlier curve', () => {
    const inputs: MeasureInputs = {
      traceData: new Map([
        ['first', line(() => 1)],
        ['second', line(() => 2)],
      ]),
      traces: [
        { id: 'first', axisId: 'a' },
        { id: 'second', axisId: 'a' },
      ],
      primaryAxisId: 'a',
    };
    expect(adoptedTraceId(measure(), inputs)).toBe('first');
  });

  it('has no curve (all —) when nothing is on the primary axis', () => {
    const inputs: MeasureInputs = { ...RAW, primaryAxisId: 'b' };
    const r = measureReadout(measure(), inputs);
    expect(r.traceId).toBeNull();
    expect(r.n).toBeNull();
    expect(r.mean).toBeNull();
    expect(r.std).toBeNull();
    expect(measureCardLines(r)[1]).toBe(ln('n = —', 'x̄ = —', 'σ = —'));
  });

  it('has no curve without trace data', () => {
    const r = measureReadout(measure(), {});
    expect(r.traceId).toBeNull();
    expect(r.dy).toBe(5);
  });
});

describe('measureReadout: binned archive data', () => {
  const BINNED: MeasureInputs = { ...RAW, binnedTraceIds: new Set(['c1']) };

  it('marks the readout binned when the adopted curve is binned', () => {
    const r = measureReadout(measure(), BINNED);
    expect(r.binned).toBe(true);
    // n counts bins and σ reads approximate.
    expect(measureCardLines(r)[1]).toBe(ln('n = 5 bins', 'x̄ = 3', 'σ ≈ 1.581'));
  });

  it('is raw when the span lies entirely after the archive data', () => {
    const inputs: MeasureInputs = { ...BINNED, archiveEndMs: new Map([['c1', 500]]) };
    expect(measureReadout(measure(), inputs).binned).toBe(false);
  });

  it('is binned when the span reaches back into the archive data', () => {
    const inputs: MeasureInputs = { ...BINNED, archiveEndMs: new Map([['c1', 2000]]) };
    expect(measureReadout(measure(), inputs).binned).toBe(true);
  });

  it('is raw when another curve is binned', () => {
    const inputs: MeasureInputs = { ...RAW, binnedTraceIds: new Set(['x']) };
    const r = measureReadout(measure(), inputs);
    expect(r.binned).toBe(false);
    expect(measureCardLines(r)[1]).toBe(ln('n = 5', 'x̄ = 3', 'σ = 1.581'));
  });

  it('labels the measure with objName using the same binned flag and values', () => {
    const axes = [{ id: 'a', name: 'Current', units: 'mA' }] as never;
    expect(measureLabel(measure(), axes, BINNED)).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, measure(), axes, true)
    );
    expect(measureLabel(measure(), axes, RAW)).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, measure(), axes, false)
    );
    expect(measureLabel(measure(), axes, RAW)).toBe('Measure Δ5 mA / 4 s');
  });
});

describe('measureCardLines', () => {
  it('formats both lines, carrying the unit on value terms', () => {
    const r = measureReadout(measure(), RAW);
    expect(measureCardLines(r, 'mA')).toEqual([
      ln('Δt = 4 s', 'Δy = 5 mA', '(50 %)'),
      ln('n = 5', 'x̄ = 3 mA', 'σ = 1.581 mA'),
    ]);
  });

  it('sets a negative change with the minus sign', () => {
    const a = measure({
      points: [
        { t: 1000, v: 15 },
        { t: 5000, v: 10 },
      ],
    });
    expect(measureCardLines(measureReadout(a, RAW))[0]).toBe(
      ln('Δt = 4 s', 'Δy = −5', '(−33.33 %)')
    );
  });
});

// ── The card in the overlay ────────────────────────────────────────────────

const GRID = { left: 0, top: 0, width: 1000, height: 200 };
function fakeProjection(): Projection {
  return projectionOf({
    tToX: (t) => t / 10,
    xToT: (x) => x * 10,
    vToY: (v, axisId) => (axisId === 'a' ? 200 - v : NaN),
    yToV: (y, axisId) => (axisId === 'a' ? 200 - y : NaN),
    gridRect: GRID,
    axisIds: ['a'],
  });
}

afterEach(cleanup);

function mount(props: {
  annotations?: Annotation[];
  draft?: Annotation | null;
  binnedTraceIds?: ReadonlySet<string>;
  selectedId?: string;
}) {
  const store = createProjectionStore(fakeProjection);
  const utils = render(
    createElement(
      'div',
      { style: { position: 'relative' } },
      createElement(AnnotationLayer, {
        projectionStore: store,
        annotations: props.annotations ?? [],
        axes: [{ id: 'a' }],
        theme: drawingThemeFor('dark'),
        draft: props.draft,
        selectedId: props.selectedId,
        // Trace's measure card over the curves (its host config's provider).
        config: {
          ...TRACE_LAYER,
          measure: {
            card: (a: Annotation, ctx: { axis?: AxisRef }) =>
              measureCardLines(
                measureReadout(a, { ...RAW, binnedTraceIds: props.binnedTraceIds }),
                ctx.axis ? (ctx.axis.unitLabel ?? ctx.axis.units) : undefined
              ),
          },
        },
      })
    )
  );
  act(() => store.bump());
  return utils.container;
}

function cardText(root: ParentNode, id: string): string[] {
  const card = root.querySelector(`[data-annotation-id="${id}"] [data-measure-card]`);
  expect(card).not.toBeNull();
  return [...card!.querySelectorAll('text')].map((t) => t.textContent ?? '');
}

describe('AnnotationLayer measure card', () => {
  it('draws the readout for a persisted measure', () => {
    const root = mount({ annotations: [measure()] });
    expect(cardText(root, 'm1')).toEqual([
      ln('Δt = 4 s', 'Δy = 5', '(50 %)'),
      ln('n = 5', 'x̄ = 3', 'σ = 1.581'),
    ]);
  });

  it('sets the readout as figure text above and right of the box, on a leader, with no card', () => {
    const root = mount({ annotations: [measure()] });
    const card = root.querySelector('[data-annotation-id="m1"] [data-measure-card]')!;
    expect(card.tagName.toLowerCase()).toBe('g');
    expect(card.querySelector('rect')).toBeNull();
    // Box x 100..500, y 185..190: the block starts 14 px right of it and ends 14 px above it.
    const texts = [...card.querySelectorAll('text')];
    expect(texts.map((t) => t.getAttribute('x'))).toEqual(['514', '514']);
    expect(texts.map((t) => t.getAttribute('y'))).toEqual(['154', '168']);
    for (const t of texts) {
      expect(t.getAttribute('fill')).toBe('#4589ff');
      expect(t.getAttribute('stroke')).toBe(drawingThemeFor('dark').bg);
      expect(t.getAttribute('paint-order')).toBe('stroke');
      expect(t.getAttribute('font-style')).toBe('italic');
      expect(t.hasAttribute('data-annotation-label')).toBe(true);
    }
    const leader = card.querySelector('path')!;
    expect(leader.getAttribute('d')).toBe('M500 185L514 171');
    expect(leader.getAttribute('stroke')).toBe('#4589ff');
    expect(leader.getAttribute('stroke-width')).toBe('0.6');
    // The drag grip shows only while the measure is selected.
    expect(card.querySelector('[data-readout-grip]')).toBeNull();
  });

  it('offers a grip on the readout of the selected measure, left out of the capture', () => {
    const root = mount({ annotations: [measure()], selectedId: 'm1' });
    const grip = root.querySelector(
      '[data-annotation-id="m1"] [data-measure-card] [data-readout-grip]'
    )!;
    expect(grip).not.toBeNull();
    expect(grip.tagName.toLowerCase()).toBe('g');
    expect(grip.hasAttribute('data-capture-skip')).toBe(true);
    expect(grip.getAttribute('pointer-events')).toBe('all');
  });

  it('draws the readout for a draft measure, without a grip', () => {
    const root = mount({ draft: measure({ id: 'd1' }), selectedId: 'd1' });
    expect(cardText(root, 'd1')[1]).toBe(ln('n = 5', 'x̄ = 3', 'σ = 1.581'));
    expect(root.querySelector('[data-readout-grip]')).toBeNull();
  });

  it('uses the binned wording when the adopted curve is binned', () => {
    const root = mount({ annotations: [measure()], binnedTraceIds: new Set(['c1']) });
    expect(cardText(root, 'm1')[1]).toBe(ln('n = 5 bins', 'x̄ = 3', 'σ ≈ 1.581'));
  });

  it('draws no card for other kinds', () => {
    const box: Annotation = { ...measure({ id: 'b1' }), kind: 'box' };
    const root = mount({ annotations: [box] });
    expect(root.querySelector('[data-measure-card]')).toBeNull();
  });
});
