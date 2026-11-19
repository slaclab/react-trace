// @vitest-environment jsdom
// Drawing tools off (`useDrawingHost`'s `toolsOff`): the rail is not
// rendered, an armed tool goes back to the cursor, and an arm key is neither
// consumed nor arms; existing drawings still render, and Delete still deletes
// the selected one. Turning the tools back on brings the rail back.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useMemo, useRef, useState } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import { CORRELATION_CATALOG } from '../catalog';
import { VALUE_X_AXIS } from '../catalog/xAxis';
import type { GridProjection, HostConfig } from '../catalog/types';
import { createProjectionStore } from '../../plot/geometry';
import type { Annotation } from '../model';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../tools';
import { projectionOf } from '../../plot/testUtils';
import { createShedStore } from './shedStore';
import type { DrawingDocument } from './useDrawingDocument';
import { useDrawingHost, useDrawingWrapperListeners, type DrawingHost } from './useDrawingHost';
import { DrawingLayers, DrawingRailFor } from './DrawingOverlay';

afterEach(cleanup);

const GRID: GridProjection = {
  tToX: (t) => t / 10,
  xToT: (x) => x * 10,
  vToY: (v) => 100 - v,
  yToV: (y) => 100 - y,
  gridRect: { left: 0, top: 0, width: 200, height: 100 },
  axisIds: ['y'],
};

const LINE: Annotation = {
  id: 'annotation-1',
  kind: 'hline',
  points: [{ t: 0, v: 50 }],
  axisId: 'y',
  color: '#ff0000',
  width: 1.5,
  text: '',
};

function mount(opts: { toolsOff?: boolean; prefs?: Partial<AnnotationToolPrefs> } = {}) {
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
  const store = createProjectionStore(() => projectionOf(GRID));
  const live = {
    list: [] as Annotation[],
    prefs: DEFAULT_TOOL_PREFS,
    host: null as DrawingHost | null,
    setToolsOff: (() => {}) as (on: boolean) => void,
  };

  function Plot() {
    const [list, setList] = useState<Annotation[]>([LINE]);
    const [prefs, setPrefsState] = useState<AnnotationToolPrefs>({
      ...DEFAULT_TOOL_PREFS,
      ...opts.prefs,
    });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [toolsOff, setToolsOff] = useState(opts.toolsOff === true);
    const document = useMemo<DrawingDocument>(
      () => ({
        annotations: list,
        commit: (fn) => setList((l) => fn(l)),
        undo: () => {},
        selectedId,
        select: setSelectedId,
        prefs,
        setPrefs: (patch) => setPrefsState((p) => ({ ...p, ...patch })),
        hidden: false,
        setHidden: () => {},
      }),
      [list, selectedId, prefs]
    );
    live.list = list;
    live.prefs = prefs;
    live.setToolsOff = setToolsOff;
    const host = useDrawingHost(config, document, store, {
      axes: [{ id: 'y' }],
      theme: drawingThemeFor('dark'),
      toolsOff,
    });
    live.host = host;
    const wrapRef = useRef<HTMLDivElement | null>(null);
    useDrawingWrapperListeners(wrapRef, host);
    return (
      <div ref={wrapRef} data-testid="wrap" style={{ position: 'relative' }}>
        <DrawingLayers host={host} />
        <DrawingRailFor host={host} />
      </div>
    );
  }

  const utils = render(<Plot />);
  act(() => store.bump());
  const wrap = utils.getByTestId('wrap');
  const rail = () => wrap.querySelector('[data-drawing-rail]');
  const key = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      wrap.dispatchEvent(ev);
    });
    return ev;
  };
  const drawn = () => wrap.querySelectorAll('[data-annotation-id]').length;
  return { wrap, live, rail, key, drawn };
}

describe('drawing tools off', () => {
  it('renders no rail while off, and the rail again once on', () => {
    const { rail, live } = mount({ toolsOff: true });
    expect(rail()).toBeNull();
    expect(live.host!.toolsOff).toBe(true);
    act(() => live.setToolsOff(false));
    expect(rail()).not.toBeNull();
    expect(live.host!.toolsOff).toBe(false);
    act(() => live.setToolsOff(true));
    expect(rail()).toBeNull();
  });

  it('disarms an armed tool when the tools go off', () => {
    const { live } = mount({ prefs: { tool: 'hline' } });
    expect(live.prefs.tool).toBe('hline');
    act(() => live.setToolsOff(true));
    expect(live.prefs.tool).toBe('cursor');
  });

  it('leaves the arm keys unconsumed and the tool unarmed while off', () => {
    const { key, live } = mount({ toolsOff: true });
    const arm = key({ key: '˙', code: 'KeyH', altKey: true });
    expect(arm.defaultPrevented).toBe(false);
    expect(live.prefs.tool).toBe('cursor');
    let out = true;
    act(() => {
      out = live.host!.handleDrawingKey({ kind: 'arm', tool: 'hline' });
    });
    expect(out).toBe(false);
    expect(live.prefs.tool).toBe('cursor');

    // On again: the same key arms.
    act(() => live.setToolsOff(false));
    expect(key({ key: '˙', code: 'KeyH', altKey: true }).defaultPrevented).toBe(true);
    expect(live.prefs.tool).toBe('hline');
  });

  it('keeps existing drawings drawn and deletable while off', () => {
    const { key, live, drawn } = mount({ toolsOff: true });
    expect(drawn()).toBeGreaterThan(0);
    act(() => live.host!.document.select(LINE.id));
    const del = key({ key: 'Delete' });
    expect(del.defaultPrevented).toBe(true);
    expect(live.list).toHaveLength(0);
  });
});
