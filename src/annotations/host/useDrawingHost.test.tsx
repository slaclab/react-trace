// @vitest-environment jsdom
// The host's own cursor store: never made while the plot passes one (Trace
// does), made once when it passes none, and kept should the prop come and go.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { drawingThemeFor } from '../../annotationTheme';
import { CORRELATION_CATALOG } from '../catalog';
import { VALUE_X_AXIS } from '../catalog/xAxis';
import type { HostConfig } from '../catalog/types';
import { createCursorStore, createProjectionStore, type CursorStore } from '../../plot/geometry';
import { DEFAULT_TOOL_PREFS } from '../tools';
import { createShedStore } from './shedStore';
import type { DrawingDocument } from './useDrawingDocument';
import { useDrawingHost } from './useDrawingHost';

const created = vi.hoisted(() => ({ cursor: [] as CursorStore[] }));
vi.mock('../../plot/geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plot/geometry')>();
  return {
    ...actual,
    createCursorStore: () => {
      const store = actual.createCursorStore();
      created.cursor.push(store);
      return store;
    },
  };
});

afterEach(() => {
  cleanup();
  created.cursor.length = 0;
});

const config: HostConfig = {
  catalog: CORRELATION_CATALOG,
  xAxis: VALUE_X_AXIS,
  snap: { snap: () => null },
  measure: { card: () => [] },
  frames: { subscribe: () => () => {}, getVersion: () => 0 },
  shed: createShedStore(),
  ownerAxisAt: () => 'y',
  hiddenReason: () => null,
};
const document: DrawingDocument = {
  annotations: [],
  commit: () => {},
  undo: () => {},
  selectedId: null,
  select: () => {},
  prefs: DEFAULT_TOOL_PREFS,
  setPrefs: () => {},
  hidden: false,
  setHidden: () => {},
};
const axes = [{ id: 'y' }];

function mount(cursorStore: CursorStore | undefined) {
  const projection = createProjectionStore(() => null);
  return renderHook(
    ({ cursorStore }: { cursorStore: CursorStore | undefined }) =>
      useDrawingHost(config, document, projection, {
        axes,
        theme: drawingThemeFor('dark'),
        cursorStore,
      }),
    { initialProps: { cursorStore } }
  );
}

describe('useDrawingHost cursor store', () => {
  it('makes none when the plot passes one', () => {
    const passed = createCursorStore();
    created.cursor.length = 0;
    const { result, rerender } = mount(passed);
    rerender({ cursorStore: passed });
    expect(created.cursor).toHaveLength(0);
    expect(result.current.cursorStore).toBe(passed);
  });

  it('makes one, once, when the plot passes none', () => {
    const { result, rerender } = mount(undefined);
    const own = result.current.cursorStore;
    rerender({ cursorStore: undefined });
    expect(created.cursor).toEqual([own]);
    expect(result.current.cursorStore).toBe(own);
  });

  it('makes one on first need and keeps it when the prop comes and goes', () => {
    const passed = createCursorStore();
    created.cursor.length = 0;
    const { result, rerender } = mount(passed);
    rerender({ cursorStore: undefined });
    const own = result.current.cursorStore;
    expect(created.cursor).toEqual([own]);
    rerender({ cursorStore: passed });
    expect(result.current.cursorStore).toBe(passed);
    rerender({ cursorStore: undefined });
    expect(result.current.cursorStore).toBe(own);
    expect(created.cursor).toHaveLength(1);
  });
});
