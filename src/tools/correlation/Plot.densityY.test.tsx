// @vitest-environment jsdom
//
// Density Y on the workbench: the choice moved off the plot
// toolbar to Properties › View (`#density-y`, a state field), so the canvas
// draws the density Y the state names — `dy`, else the first Y — and offers no
// control of its own. `correlationPlotInput` is the one place the state is
// turned into the chart's input; the Code tabs read the same input.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TableResultDTO } from '@slaclab/canopy-client';
import { drawingThemeFor } from '../../annotationTheme';
import { defaultCorrelationState, type CorrelationState } from './query';
import type { FrameLike } from './stats';

const { options } = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{
    className?: string;
    option: Record<string, unknown>;
  }> {
    render() {
      if (this.props.className === 'correlation-plot__chart') options.push(this.props.option);
      return React.createElement('div', { className: this.props.className });
    }
  }
  return { default: MockECharts };
});

const { CorrelationCanvas, correlationPlotInput, plotSettingsOf, useCorrelationFrame } =
  await import('./Plot');

const S = 1_000_000_000;
const BASE = 1_790_000_000_000_000_000;

function frame(): FrameLike {
  const tsNs = Array.from({ length: 5 }, (_, i) => BASE + i * S);
  const columns: Record<string, number[]> = {
    x: tsNs.map((_, i) => i),
    y1: tsNs.map((_, i) => 2 * i + 1),
    y2: tsNs.map((_, i) => 3 * i),
  };
  const columnPvs: Record<string, string> = { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV' };
  const table: TableResultDTO = { tsNs, columns, inputs: {}, totalRows: tsNs.length };
  return { table, columnPvs };
}

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return { ...defaultCorrelationState(), x: 'X:PV', ys: ['Y1:PV', 'Y2:PV'], ...over };
}

const NO_UNITS = () => '';

/** One frame for every render: a new one per render would never settle the strips. */
const FRAME = frame();

function Harness({ s }: { s: CorrelationState }) {
  const onScreen = useCorrelationFrame(FRAME, s.metrics);
  return (
    <CorrelationCanvas
      state={s}
      frame={onScreen}
      unitsOf={NO_UNITS}
      chartTheme={drawingThemeFor('dark')}
    />
  );
}

/** The names of the density (custom) series of the newest chart option. */
function densityNames(): (string | undefined)[] {
  const series = options[options.length - 1].series as { type: string; name?: string }[];
  return series.filter((s) => s.type === 'custom').map((s) => s.name);
}

beforeEach(() => {
  options.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('correlationPlotInput', () => {
  const base = { unitsOf: NO_UNITS, theme: drawingThemeFor('dark'), width: 900 };

  it('takes the density Y from `dy`, else the first Y', () => {
    expect(correlationPlotInput(state({ view: 'density' }), null, base).densityPv).toBe('Y1:PV');
    expect(
      correlationPlotInput(state({ view: 'density', dy: 'Y2:PV' }), null, base).densityPv
    ).toBe('Y2:PV');
  });

  it('places panels by the width only in the split scatter', () => {
    expect(correlationPlotInput(state({ axes: 'split' }), null, base).width).toBe(900);
    expect(correlationPlotInput(state({ axes: 'shared' }), null, base).width).toBe(0);
    expect(correlationPlotInput(state({ view: 'density', axes: 'split' }), null, base).width).toBe(
      0
    );
  });

  it('carries what the state pins: hidden Ys, colours, markers and the toggles', () => {
    const s = state({
      hidden: { 'Y2:PV': true },
      colors: { 'Y1:PV': '#123456' },
      fit: false,
      legend: false,
      grid: false,
      crosshair: true,
      fade: true,
    });
    const input = correlationPlotInput(s, null, base);
    expect([...input.hidden]).toEqual(['Y2:PV']);
    expect(input.colors?.get('Y1:PV')).toBe('#123456');
    expect(input).toMatchObject({ fit: false, legend: false, grid: false, crosshair: true });
    expect(input.fade).toBe(true);
    expect(plotSettingsOf(s).hidden).toEqual(input.hidden);
  });
});

describe('CorrelationCanvas density view', () => {
  it('draws the first Y while `dy` is automatic', () => {
    render(<Harness s={state({ view: 'density' })} />);
    expect(densityNames()).toEqual(['Y1:PV']);
  });

  it('draws the Y the state names', () => {
    render(<Harness s={state({ view: 'density', dy: 'Y2:PV' })} />);
    expect(densityNames()).toEqual(['Y2:PV']);
  });

  it('offers no Density Y control or toolbar of its own', () => {
    render(<Harness s={state({ view: 'density' })} />);
    expect(screen.queryByRole('combobox', { name: 'Density Y' })).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(document.querySelector('select')).toBeNull();
  });
});
