// A locked drawing's card: "A locked drawing cannot be moved, reshaped or
// restyled" and "A locked note keeps its text". While it is locked, the
// card's style and geometry fields are disabled with the reason "Locked";
// a locked note's Label too. Locked, Visible and Delete stay available, and
// everything comes back on unlock.
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG } from '../catalog/index';
import type { AxisRef } from '../catalog/types';
import type { Annotation } from '../model';
import type { FieldDef, Target, ToolContext } from '../../workbench/types';
import { disabledReason } from '../../workbench/fields/logic';
import { createDrawingSchema, DRAWING_ITEM_KIND, type DrawingAccess } from './workbench';

interface Host {
  drawings: Annotation[];
  axes: AxisRef[];
}

const access: DrawingAccess<Host> = {
  list: (state) => state.drawings,
  patch: (state, id, fn) => ({
    ...state,
    drawings: state.drawings.map((a) => (a.id === id ? fn(a) : a)),
  }),
  remove: (state, id) => ({ ...state, drawings: state.drawings.filter((a) => a.id !== id) }),
  axes: (state) => state.axes,
};

const FIELDS = createDrawingSchema<Host, unknown>(access, {
  catalog: BUILTIN_CATALOG,
}).tabs.flatMap((t) => t.fields) as FieldDef<Host, unknown>[];

function ctxOf(a: Annotation): ToolContext<Host, unknown> {
  const target: Target = { level: 'item', kind: DRAWING_ITEM_KIND, id: a.id };
  return {
    state: { drawings: [a], axes: [{ id: 'y1', name: 'Y' }] },
    model: undefined,
    update: () => {},
    selection: target,
    target,
    capabilities: { elog: false },
    ui: {},
  };
}

function drawing(kind: string, locked: boolean): Annotation {
  return {
    id: `d-${kind}`,
    kind,
    points:
      kind === 'trend'
        ? [
            { t: 1, v: 1 },
            { t: 2, v: 2 },
          ]
        : [{ t: 1, v: 1 }],
    axisId: 'y1',
    color: '#336699',
    width: 1,
    text: 'kept',
    ...(locked ? { locked: true } : {}),
  };
}

/** Each field id the drawing's card shows, with its disabled reason. */
function reasons(a: Annotation): Record<string, false | string> {
  const ctx = ctxOf(a);
  const out: Record<string, false | string> = {};
  for (const f of FIELDS) {
    if (f.when && !f.when(ctx)) continue;
    out[f.id] = disabledReason(f, ctx);
  }
  return out;
}

describe('a locked drawing card', () => {
  it('disables restyling, moving and reshaping with the reason "Locked"', () => {
    expect(reasons(drawing('hline', true))).toEqual({
      'annotation-kind': false,
      'annotation-label': false,
      'annotation-color': 'Locked',
      'annotation-width': 'Locked',
      'annotation-style': 'Locked',
      'annotation-axis': 'Locked',
      'annotation-value': 'Locked',
      'annotation-locked': false,
      'annotation-visible': false,
      'annotation-delete': false,
    });
    expect(reasons(drawing('trend', true))['annotation-extend']).toBe('Locked');
  });

  it('keeps a locked note’s text', () => {
    expect(reasons(drawing('note', true))['annotation-label']).toBe('Locked');
  });

  it('enables everything again once unlocked', () => {
    for (const kind of ['hline', 'trend', 'note']) {
      for (const [id, reason] of Object.entries(reasons(drawing(kind, false)))) {
        expect(reason, `${kind} ${id}`).toBe(false);
      }
    }
  });
});
