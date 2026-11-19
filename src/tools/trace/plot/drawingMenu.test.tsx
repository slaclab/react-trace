// @vitest-environment jsdom
//
// Trace's drawing menu on the plot: a right-click on a drawing opens the
// workbench menu headed by the drawing's name, with Edit (selects it, which
// opens its card), Lock / Unlock and Delete, each written through the plot's
// drawing writer as one commit. A right-click beside it still opens the
// point menu, whose "Add note here" opens the new note's text box, focused,
// as placing a note with the tool does; Escape there removes the empty note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { fireEvent } from '@testing-library/dom';
import { SinglePlot } from '../../../components/PlotArea';
import type { Axis, Plot } from '../../../types';
import type { Annotation } from '../../../annotations/model';
import { ContextMenuProvider } from '../../../workbench/contextMenu/ContextMenuHost';
import { chartStub } from '../../../test/chartStub';

const { fakeInstance } = vi.hoisted(() => {
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: () => 0,
    convertFromPixel: (() => 0) as (finder: object, px: number) => number,
  };
  return { fakeInstance };
});

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../../../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = fakeInstance;

const AXIS: Axis = {
  id: 'ax1',
  name: 'Current',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

const VLINE: Annotation = {
  id: 'v1',
  kind: 'vline',
  points: [{ t: 1_799_999_000_000, v: 0 }],
  axisId: 'ax1',
  color: '#336699',
  width: 1,
  text: '',
};

function makePlot(annotations: Annotation[]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [AXIS],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-10m' },
    annotations,
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(annotations: Annotation[] = [VLINE]) {
  const onCommitAnnotations = vi.fn();
  const onSelectAnnotation = vi.fn();
  const { container } = render(
    <ContextMenuProvider schemaWriters={{}}>
      <SinglePlot
        plot={makePlot(annotations)}
        archiveResults={new Map()}
        liveResults={new Map()}
        formulaResults={new Map()}
        onCommitAnnotations={onCommitAnnotations}
        onSelectAnnotation={onSelectAnnotation}
      />
    </ContextMenuProvider>
  );
  const wrap = container.querySelector('[data-plot-id]') as HTMLElement;
  return { wrap, onCommitAnnotations, onSelectAnnotation };
}

const menu = () => document.body.querySelector('[data-plot-menu="context"]') as HTMLElement | null;
const labels = () =>
  [...menu()!.querySelectorAll('[role="menuitem"]')].map((li) => li.textContent?.trim());
const header = () => menu()?.querySelector('.wb-context-menu__header')?.textContent;
const click = (name: string) =>
  act(() => {
    fireEvent.click(within(menu()!).getByText(name).closest('li')!);
  });

function rightClick(el: Element) {
  act(() => {
    fireEvent.contextMenu(el, { clientX: 400, clientY: 200, button: 2 });
  });
}

describe('Trace drawing menu', () => {
  it('a right-click on a drawing opens its menu: Edit, Lock, Delete', () => {
    const { wrap, onSelectAnnotation } = mount();
    const shape = wrap.querySelector('[data-annotation-id="v1"]')!;
    expect(shape).not.toBeNull();
    rightClick(shape);
    expect(menu()).not.toBeNull();
    expect(header()).toMatch(/^V-line/);
    expect(labels()).toEqual(['Edit', 'Lock', 'Delete']);
    click('Edit');
    expect(onSelectAnnotation).toHaveBeenCalledWith('v1');
  });

  it('Lock and Delete are one commit each', () => {
    const { wrap, onCommitAnnotations } = mount();
    rightClick(wrap.querySelector('[data-annotation-id="v1"]')!);
    click('Lock');
    expect(onCommitAnnotations).toHaveBeenCalledTimes(1);
    const [lock, lockLabel] = onCommitAnnotations.mock.calls[0];
    expect(lockLabel).toBe('Lock V-line');
    expect((lock([VLINE]) as Annotation[])[0].locked).toBe(true);

    rightClick(wrap.querySelector('[data-annotation-id="v1"]')!);
    click('Delete');
    const [del, delLabel] = onCommitAnnotations.mock.calls[1];
    expect(delLabel).toBe('Delete V-line');
    expect(del([VLINE])).toEqual([]);
  });

  it('a locked drawing offers Unlock, and Delete stays', () => {
    const locked = { ...VLINE, locked: true as const };
    const { wrap, onCommitAnnotations } = mount([locked]);
    rightClick(wrap.querySelector('[data-annotation-id="v1"]')!);
    expect(labels()).toEqual(['Edit', 'Unlock', 'Delete']);
    click('Unlock');
    const [fn] = onCommitAnnotations.mock.calls[0];
    expect('locked' in (fn([locked]) as Annotation[])[0]).toBe(false);
  });

  it('a right-click beside the drawing still opens the point menu', () => {
    const { wrap } = mount();
    rightClick(wrap);
    expect(labels()).toContain('Add vertical line here');
    expect(labels()).not.toContain('Lock');
  });
});

describe('Add note here', () => {
  function Stateful() {
    const [list, setList] = useState<Annotation[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const plot = useMemo(() => makePlot(list), [list]);
    return (
      <ContextMenuProvider schemaWriters={{}}>
        <SinglePlot
          plot={plot}
          archiveResults={new Map()}
          liveResults={new Map()}
          formulaResults={new Map()}
          onCommitAnnotations={(fn) => setList((l) => fn(l))}
          selectedAnnotationId={selected}
          onSelectAnnotation={setSelected}
        />
      </ContextMenuProvider>
    );
  }

  it('Escape on the note just added leaves no empty note behind', () => {
    const original = fakeInstance.convertFromPixel;
    fakeInstance.convertFromPixel = (finder: object, px: number) =>
      'xAxisIndex' in finder ? px * 10 : 400 - px;
    try {
      const { container } = render(<Stateful />);
      const wrap = container.querySelector('[data-plot-id]') as HTMLElement;
      rightClick(wrap);
      click('Add note here');
      const editor = container.querySelector<HTMLInputElement>('input[data-annotation-editor]')!;
      expect(container.querySelector('[data-annotation-id]')).not.toBeNull();
      act(() => {
        fireEvent.keyDown(editor, { key: 'Escape' });
      });
      expect(container.querySelector('input[data-annotation-editor]')).toBeNull();
      expect(container.querySelector('[data-annotation-id]')).toBeNull();
    } finally {
      fakeInstance.convertFromPixel = original;
    }
  });

  it('adds the note and opens its text box, focused; Enter keeps the text', () => {
    // A linear fake: t = 10 * x on the time axis, v = 400 - y on every Y axis.
    const original = fakeInstance.convertFromPixel;
    fakeInstance.convertFromPixel = (finder: object, px: number) =>
      'xAxisIndex' in finder ? px * 10 : 400 - px;
    try {
      const { container } = render(<Stateful />);
      const wrap = container.querySelector('[data-plot-id]') as HTMLElement;
      rightClick(wrap);
      click('Add note here');
      expect(menu()).toBeNull();
      const editor = container.querySelector<HTMLInputElement>('input[data-annotation-editor]');
      expect(editor).not.toBeNull();
      expect(document.activeElement).toBe(editor);
      act(() => {
        fireEvent.change(editor!, { target: { value: 'beam lost' } });
        fireEvent.keyDown(editor!, { key: 'Enter' });
      });
      expect(container.querySelector('input[data-annotation-editor]')).toBeNull();
      expect(container.querySelector('[data-annotation-id] text')?.textContent).toContain(
        'beam lost'
      );
    } finally {
      fakeInstance.convertFromPixel = original;
    }
  });
});
