// @vitest-environment jsdom
// Note tool definition: identity, placement, inline text, hint,
// commit labels, callout geometry and coordinates, and that its Shape renders
// the same marks as today's layer.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { drawingThemeFor } from '../../../annotationTheme';
import { NoteIcon } from '../../icons';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { type Annotation, objNameIn } from '../../model';
import { AnnotationLayer } from '../../AnnotationLayer';
import registryRaw from '../../__fixtures__/registry.json?raw';
import type { GridProjection } from '../types';
import { TIME_X_AXIS } from '../xAxis';
import { noteCallout } from '../shapeKit';
import { NOTE_TOOL } from './def';
import { BUILTIN_CATALOG } from '..';
import { toolHintIn } from '../../statusHints';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

afterEach(cleanup);

const GRID = { left: 60, top: 20, width: 400, height: 200 };
const tToX = (t: number) => GRID.left + t / 10;
const xToT = (x: number) => (x - GRID.left) * 10;
const vToY = (v: number, axisId: string) =>
  axisId === 'a' ? 220 - v : axisId === 'log' ? (v > 0 ? 220 - 50 * Math.log10(v) : NaN) : NaN;
const yToV = (y: number, axisId: string) => (axisId === 'a' ? 220 - y : NaN);

const grid: GridProjection = { tToX, xToT, vToY, yToV, gridRect: GRID, axisIds: ['a', 'log'] };
const ctx = { theme: drawingThemeFor('dark'), xAxis: TIME_X_AXIS };

function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'n',
    kind: 'note',
    points: [{ t: 1000, v: 100 }],
    axisId: 'a',
    color: '#4589ff',
    width: 2,
    text: 'beam dump',
    ...over,
  };
}

describe('NOTE_TOOL identity and placement', () => {
  it('matches the registry pin', () => {
    const registry = JSON.parse(registryRaw) as { tools: Record<string, unknown>[] };
    const pin = registry.tools.find((t) => t.kind === 'note')!;
    expect(NOTE_TOOL.kind).toBe('note');
    expect(NOTE_TOOL.code).toBe(5);
    expect(NOTE_TOOL.code).toBe(pin.code);
    expect(NOTE_TOOL.key).toBe('n');
    expect(NOTE_TOOL.key).toBe(pin.key);
    expect(NOTE_TOOL.label).toEqual({ long: 'Note', short: 'Note' });
    expect(NOTE_TOOL.label).toEqual({ long: pin.label, short: pin.shortLabel });
    expect(NOTE_TOOL.icon).toBe(NoteIcon);
    expect(NOTE_TOOL.arity).toBe(1);
    expect(NOTE_TOOL.axes).toBe('xy');
    expect(NOTE_TOOL.menuAdd).toEqual({ label: 'Add note here' });
    expect(NOTE_TOOL.inlineText).toBe(true);
    expect(NOTE_TOOL.codec).toEqual({ layout: 'tv' });
    expect(NOTE_TOOL.fields).toEqual([]);
    expect(NOTE_TOOL.validate).toBeUndefined();
    expect(NOTE_TOOL.card).toBeUndefined();
    expect(NOTE_TOOL.modifierGesture).toBeUndefined();
  });

  it('shapePoint keeps both coordinates', () => {
    expect(NOTE_TOOL.shapePoint({ t: 1234, v: 5.5 })).toEqual({ t: 1234, v: 5.5 });
  });

  it('commit labels read Draw/Move/Edit/Delete Note', () => {
    const short = NOTE_TOOL.label.short;
    expect(['Draw', 'Move', 'Edit', 'Delete'].map((l) => `${l} ${short}`)).toEqual([
      'Draw Note',
      'Move Note',
      'Edit Note',
      'Delete Note',
    ]);
  });
});

describe('NOTE_TOOL text', () => {
  it('objName equals base objName', () => {
    const cases = [
      '',
      '   ',
      'beam dump',
      '  two\n  lines\there ',
      'exactly twenty-four char',
      'this note body is longer than twenty-four characters',
    ];
    for (const text of cases) {
      const a = ann({ text });
      expect(NOTE_TOOL.objName(a, { xAxis: TIME_X_AXIS })).toBe(
        objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [])
      );
    }
    expect(NOTE_TOOL.objName(ann({ text: '' }), { xAxis: TIME_X_AXIS })).toBe('Note');
    expect(NOTE_TOOL.objName(ann({ text: ' a\n b ' }), { xAxis: TIME_X_AXIS })).toBe('Note “a b”');
    expect(
      NOTE_TOOL.objName(ann({ text: 'this note body is longer than 24' }), { xAxis: TIME_X_AXIS })
    ).toBe('Note “this note body is longe…”');
  });

  it('hint equals the base status hint', () => {
    expect(NOTE_TOOL.hint({ xAxis: TIME_X_AXIS })).toBe(
      toolHintIn(BUILTIN_CATALOG, 'note', { xAxis: TIME_X_AXIS })
    );
    expect(NOTE_TOOL.hint({ xAxis: TIME_X_AXIS })).toBe('Note: click to place, then type');
  });
});

describe('NOTE_TOOL geometry', () => {
  it('places the text up and right of the anchor, on a leader', () => {
    // anchor (160, 120); text 9 chars -> w = max(40, 9*5.6+8) = 58.4
    const g = NOTE_TOOL.geometry(ann(), grid, ctx);
    expect(g).not.toBeNull();
    const { bx, by, w, h } = noteCallout(160, 120, 'beam dump', 460);
    expect([bx, by, h]).toEqual([174, 90, 20]);
    expect(w).toBeCloseTo(58.4);
    expect(g!.outline).toEqual(['M160 120L174 106']);
    expect(g!.handles).toEqual([[160, 120]]);
    expect(g!.lockAt).toEqual([174 + w, 90]);
    const { container } = render(<svg>{g!.body}</svg>);
    const leader = container.querySelector('path')!;
    expect(leader.getAttribute('d')).toBe('M160 120L174 106');
    expect(leader.getAttribute('stroke-width')).toBe('0.6');
    const anchor = container.querySelector('circle')!;
    expect([anchor.getAttribute('cx'), anchor.getAttribute('cy')]).toEqual(['160', '120']);
    expect(anchor.getAttribute('r')).toBe('1.5');
    const text = container.querySelector('text')!;
    expect([text.getAttribute('x'), text.getAttribute('y')]).toEqual(['176', '104']);
    expect(text.getAttribute('text-anchor')).toBe('start');
    expect(container.querySelector('rect')).toBeNull();
  });

  it('flips the text left near the right edge', () => {
    const a = ann({ points: [{ t: 3900, v: 100 }] }); // x = 450
    const g = NOTE_TOOL.geometry(a, grid, ctx)!;
    expect(g.outline).toEqual(['M450 120L436 106']);
    expect(g.lockAt).toEqual([450 - 14, 90]);
    const { container } = render(<svg>{g.body}</svg>);
    expect(container.querySelector('path')?.getAttribute('d')).toBe('M450 120L436 106');
    const text = container.querySelector('text')!;
    expect(text.getAttribute('x')).toBe('434');
    expect(text.getAttribute('text-anchor')).toBe('end');
    const hit = render(<svg>{g.hits}</svg>).container.querySelector('rect[data-annotation-hit]')!;
    expect(Number(hit.getAttribute('x'))).toBeCloseTo(450 - 14 - (9 * 5.6 + 8));
  });

  it('uses a 40 px minimum text box for empty text', () => {
    const g = NOTE_TOOL.geometry(ann({ text: '' }), grid, ctx)!;
    expect(g.outline).toEqual(['M160 120L174 106']);
    expect(g.lockAt).toEqual([214, 90]);
    const hit = render(<svg>{g.hits}</svg>).container.querySelector('rect[data-annotation-hit]')!;
    expect(hit.getAttribute('width')).toBe('40');
  });

  it('is null with no points, an axis the grid does not draw, or a non-finite x/y', () => {
    expect(NOTE_TOOL.geometry(ann({ points: [] }), grid, ctx)).toBeNull();
    expect(NOTE_TOOL.geometry(ann({ axisId: 'zz' }), grid, ctx)).toBeNull();
    expect(NOTE_TOOL.geometry(ann(), { ...grid, axisIds: ['log'] }, ctx)).toBeNull();
    expect(
      NOTE_TOOL.geometry(ann({ axisId: 'log', points: [{ t: 0, v: -1 }] }), grid, ctx)
    ).toBeNull();
    expect(NOTE_TOOL.geometry(ann({ points: [{ t: Number.NaN, v: 1 }] }), grid, ctx)).toBeNull();
  });

  it('hits the callout box (f) and the anchor (a)', () => {
    const g = NOTE_TOOL.geometry(ann(), grid, ctx)!;
    const { container } = render(<svg>{g.hits}</svg>);
    const rect = container.querySelector('rect[data-annotation-hit]');
    expect(rect?.getAttribute('x')).toBe('174');
    expect(rect?.getAttribute('y')).toBe('90');
    expect(rect?.getAttribute('height')).toBe('20');
    const circle = container.querySelector('circle[data-annotation-hit]');
    expect(circle?.getAttribute('cx')).toBe('160');
    expect(circle?.getAttribute('cy')).toBe('120');
    expect(circle?.getAttribute('r')).toBe('8');
    expect(circle?.getAttribute('pointer-events')).toBe('all');
  });

  it('sets the text in the drawing colour on a halo of the plot background, with no card', () => {
    const g = NOTE_TOOL.geometry(ann(), grid, ctx)!;
    const { container } = render(<svg>{g.body}</svg>);
    expect(container.querySelector('[data-annotation-callout]')).toBeNull();
    const text = container.querySelector('text[data-annotation-label]');
    expect(text?.getAttribute('fill')).toBe('#4589ff');
    expect(text?.getAttribute('stroke')).toBe(drawingThemeFor('dark').bg);
    expect(text?.getAttribute('stroke-width')).toBe('3');
    expect(text?.getAttribute('paint-order')).toBe('stroke');
    expect(text?.getAttribute('font-family')).toBe(
      drawingThemeFor('dark').annotation.label.fontFamily
    );
    expect(text?.getAttribute('font-size')).toBe('11');
    expect(text?.getAttribute('font-style')).toBe('italic');
    expect(text?.textContent).toBe('beam dump');
  });
});

describe('NOTE_TOOL Shape renders the same marks as base', () => {
  function attrs(el: Element | null | undefined) {
    if (!el) return null;
    return {
      ...Object.fromEntries(Array.from(el.attributes).map((x) => [x.name, x.value])),
      body: el.textContent,
    };
  }

  function marks(root: Element | null | undefined) {
    return {
      leader: attrs(root?.querySelector('path[stroke]:not([stroke="transparent"])')),
      anchor: attrs(root?.querySelector('circle[pointer-events="none"]')),
      text: attrs(root?.querySelector('text[data-annotation-label]')),
    };
  }

  function baseMarks(a: Annotation) {
    const store = createProjectionStore((): Projection => projectionOf(grid));
    const utils = render(
      <div style={{ position: 'relative' }}>
        <AnnotationLayer
          config={TRACE_LAYER}
          projectionStore={store}
          annotations={[a]}
          axes={[{ id: 'a' }, { id: 'log' }]}
          theme={drawingThemeFor('dark')}
        />
      </div>
    );
    act(() => store.bump());
    const out = marks(utils.container.querySelector(`[data-annotation-id="${a.id}"]`));
    utils.unmount();
    return out;
  }

  function toolMarks(a: Annotation) {
    const g = NOTE_TOOL.geometry(a, grid, ctx)!;
    const Shape = NOTE_TOOL.Shape;
    const { container, unmount } = render(
      <svg>
        <Shape annotation={a} geometry={g} />
      </svg>
    );
    const out = marks(container);
    unmount();
    return out;
  }

  it.each([
    ['plain', ann()],
    ['dashed and wide', ann({ dash: true, width: 3, color: '#ff8389', text: 'kick' })],
    ['flipped at the right edge', ann({ points: [{ t: 3900, v: 50 }] })],
    ['empty text', ann({ text: '' })],
    ['on the log axis', ann({ axisId: 'log', points: [{ t: 500, v: 10 }] })],
  ])('%s', (_name, a) => {
    const base = baseMarks(a);
    const tool = toolMarks(a);
    expect(base.text).not.toBeNull();
    expect(base.leader).not.toBeNull();
    expect(tool).toEqual(base);
  });
});
