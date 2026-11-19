// @vitest-environment jsdom
//
// The palette choice is remembered, as on main: a palette picked in a plot's
// Palette field is the user's palette from then on. Every plot added after it
// opens in it, and so does a fresh tab (`trace.palette` in localStorage).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { captured, currentPlots, resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { LEGACY_PALETTE_KEY } from '../state/paletteStore';
import { colorForIndex, getPalette } from '../palettes';
import { patchCurve } from '../tools/trace/schema/curve';
import { TraceApp } from './TraceApp';

vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock('../workbench/WorkbenchLayout', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.WorkbenchLayout(await importOriginal())
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.wb-plot-section[data-section="${id}"]`);
  if (!el) throw new Error(`no plot section ${id}`);
  return el;
}

// Open the Display section and its More levels down to the Palette field.
function paletteSelect(): HTMLSelectElement {
  const display = section('display');
  if (!display.querySelector('#plot-palette')) {
    fireEvent.click(display.querySelector<HTMLElement>('.wb-plot-section__head')!);
  }
  for (let i = 0; i < 3 && !display.querySelector('#plot-palette'); i++) {
    const more = within(display).queryAllByRole('button', { name: 'More' });
    if (more.length === 0) break;
    fireEvent.click(more[more.length - 1]);
  }
  const select = display.querySelector<HTMLSelectElement>('#plot-palette');
  if (!select) throw new Error('no Palette field');
  return select;
}

beforeEach(() => resetHarness());
afterEach(() => cleanup());

describe('the remembered palette', () => {
  it('a pick is remembered, and the next plot opens in it', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    expect(window.localStorage.getItem(LEGACY_PALETTE_KEY)).toBeNull();
    fireEvent.change(paletteSelect(), { target: { value: 'viridis' } });
    expect(currentPlots()[0].palette).toBe('viridis');
    expect(window.localStorage.getItem(LEGACY_PALETTE_KEY)).toBe('viridis');

    act(() => captured.plotArea!.onAddPlot());
    const plots = currentPlots();
    expect(plots).toHaveLength(2);
    expect(plots[1].palette).toBe('viridis');
  });

  it('a fresh tab opens in the remembered palette', () => {
    window.localStorage.setItem(LEGACY_PALETTE_KEY, 'viridis');
    render(<TraceApp />, { wrapper: WithCanopy });
    expect(currentPlots()[0].palette).toBe('viridis');
    act(() => captured.plotArea!.onAddPlot());
    expect(currentPlots()[1].palette).toBe('viridis');
  });

  it('with nothing remembered, an added plot opens in the default palette', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    act(() => captured.plotArea!.onAddPlot());
    expect(currentPlots()[1].palette).toBeUndefined();
  });
});

describe('re-picking the current palette', () => {
  // Main's "Apply to all traces": every curve back at its palette colour by
  // position, user-set colours included. A native select fires nothing when
  // its current option is chosen again, so the swatch strip is the re-pick.
  it('resets every curve, user-set colours included, to the palette', () => {
    window.history.replaceState(null, '', '/?pv=TEST:SINE&pv=TEST:FAST&range=-1h');
    try {
      render(<TraceApp />, { wrapper: WithCanopy });
      fireEvent.change(paletteSelect(), { target: { value: 'viridis' } });
      const viridis = getPalette('viridis');
      const [sine, fast] = currentPlots()[0].traces;
      act(() => captured.layout!.update((s) => patchCurve(s, fast.id, { color: '#123456' })));
      expect(currentPlots()[0].traces.map((t) => t.color)).toEqual([
        colorForIndex(viridis, 0),
        '#123456',
      ]);

      fireEvent.click(screen.getByRole('button', { name: 'Re-pick this palette' }));
      const plot = currentPlots()[0];
      expect(plot.palette).toBe('viridis');
      expect(plot.traces.map((t) => [t.id, t.color])).toEqual([
        [sine.id, colorForIndex(viridis, 0)],
        [fast.id, colorForIndex(viridis, 1)],
      ]);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});
