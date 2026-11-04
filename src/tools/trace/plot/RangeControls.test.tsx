// @vitest-environment jsdom
//
// RangeControls: every control writes a fresh xAxis through
// onApplyXAxis — presets, All (disabled when nothing is loaded), go to (custom
// From/To of the current span centred on the date, whole minutes, From < To)
// and Now (last relative span, else -1h).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Plot } from '../../../types';
import type { ArchiveSeriesResult } from '../../../hooks/useArchiveSeries';
import { msToNs, toDatetimeLocal } from '../../../api/time';
import { RANGE_CHIPS, goToXAxis, RangeControls, type RangeControlsProps } from './RangeControls';

const T0 = new Date(2026, 9, 14, 12, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const X: Plot['xAxis'] = { timeRange: '-1h' };

function archiveFrom(startMs: number): Map<string, ArchiveSeriesResult> {
  const result = {
    mean: [
      { time: startMs, value: 1 },
      { time: T0, value: 2 },
    ],
  } as unknown as ArchiveSeriesResult;
  return new Map([['t1', result]]);
}

function setup(overrides: Partial<RangeControlsProps> = {}) {
  const onApplyXAxis = vi.fn<(x: Plot['xAxis']) => void>();
  const props: RangeControlsProps = {
    xAxis: X,
    results: {},
    visibleTraceIds: ['t1'],
    onApplyXAxis,
    ...overrides,
  };
  const view = render(<RangeControls {...props} />);
  return { onApplyXAxis, props, view };
}

const chip = (value: string) =>
  document.querySelector(`[data-range-chip="${value}"]`) as HTMLButtonElement;
const goto = () => document.querySelector('[data-range-goto]') as HTMLInputElement;

describe('RangeControls', () => {
  it('renders the 1h/6h/24h chips from the shared preset list, plus All, go to and Now', () => {
    setup();
    expect(RANGE_CHIPS).toEqual([
      { value: '-1h', label: '1h' },
      { value: '-6h', label: '6h' },
      { value: '-1d', label: '24h' },
    ]);
    const root = document.querySelector('[data-range-controls]')!;
    expect(root).not.toBeNull();
    expect(screen.getByText('1h')).toBeTruthy();
    expect(screen.getByText('6h')).toBeTruthy();
    expect(screen.getByText('24h')).toBeTruthy();
    expect(screen.getByText('All')).toBeTruthy();
    expect(screen.getByText('Now')).toBeTruthy();
    expect(goto().type).toBe('datetime-local');
  });

  it.each([
    ['-1h', '1h'],
    ['-6h', '6h'],
    ['-1d', '24h'],
  ])('the %s chip writes that relative range, keeping other fields', (value) => {
    const xAxis: Plot['xAxis'] = { timeRange: 'custom', timeFrom: 'a', timeTo: 'b' };
    const { onApplyXAxis } = setup({ xAxis });
    fireEvent.click(chip(value));
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    expect(onApplyXAxis.mock.calls[0][0]).toEqual({ ...xAxis, timeRange: value });
  });

  it('re-picking the active preset still produces a new object', () => {
    const { onApplyXAxis } = setup({ xAxis: X });
    expect(chip('-1h').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip('-1h'));
    fireEvent.click(chip('-1h'));
    const [a, b] = onApplyXAxis.mock.calls.map((c) => c[0]);
    expect(a).toEqual({ timeRange: '-1h' });
    expect(a).not.toBe(X);
    expect(b).not.toBe(a);
  });

  it('All applies allLoadedXAxis(…) as a relative span', () => {
    const { onApplyXAxis } = setup({ results: { archive: archiveFrom(T0 - 3 * HOUR) } });
    expect(chip('all').disabled).toBe(false);
    fireEvent.click(chip('all'));
    expect(onApplyXAxis).toHaveBeenCalledWith({ timeRange: '-3h' });
  });

  it('All is disabled, and writes nothing, when no visible curve holds a sample', () => {
    const { onApplyXAxis } = setup({
      results: { archive: archiveFrom(T0 - 3 * HOUR) },
      visibleTraceIds: [],
    });
    expect(chip('all').disabled).toBe(true);
    fireEvent.click(chip('all'));
    expect(onApplyXAxis).not.toHaveBeenCalled();
  });

  it('Now writes the last relative span as a fresh xAxis', () => {
    const xAxis: Plot['xAxis'] = { timeRange: 'custom', timeFrom: 'x', timeTo: 'y' };
    const { onApplyXAxis } = setup({ xAxis, getLastRelativeSpan: () => '-6h' });
    fireEvent.click(chip('now'));
    expect(onApplyXAxis.mock.calls[0][0]).toEqual({ ...xAxis, timeRange: '-6h' });
    expect(onApplyXAxis.mock.calls[0][0]).not.toBe(xAxis);
  });

  it('Now falls back to -1h and re-clicking yields a new object each time', () => {
    const { onApplyXAxis } = setup({ getLastRelativeSpan: () => undefined });
    fireEvent.click(chip('now'));
    fireEvent.click(chip('now'));
    const [a, b] = onApplyXAxis.mock.calls.map((c) => c[0]);
    expect(a).toEqual({ timeRange: '-1h' });
    expect(a).not.toBe(b);
  });

  it('go to writes custom From/To of the current span centred on the date', () => {
    const view: { fromNs: number; toNs: number } = {
      fromNs: msToNs(T0 - 2 * HOUR),
      toNs: msToNs(T0),
    };
    const { onApplyXAxis } = setup({ viewWindowNs: view });
    const center = new Date(2026, 9, 10, 8, 30).getTime();
    fireEvent.change(goto(), { target: { value: toDatetimeLocal(center) } });
    fireEvent.keyDown(goto(), { key: 'Enter' });
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    expect(onApplyXAxis.mock.calls[0][0]).toEqual({
      timeRange: 'custom',
      timeFrom: toDatetimeLocal(center - HOUR),
      timeTo: toDatetimeLocal(center + HOUR),
    });
    // The blur after Enter does not write the same go-to again.
    fireEvent.blur(goto());
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
  });

  it('go to commits on blur, and ignores an empty value', () => {
    const { onApplyXAxis } = setup();
    fireEvent.blur(goto());
    expect(onApplyXAxis).not.toHaveBeenCalled();
    const center = new Date(2026, 9, 10, 8, 30).getTime();
    fireEvent.change(goto(), { target: { value: toDatetimeLocal(center) } });
    fireEvent.blur(goto());
    // No view window: the span is the xAxis's own (-1h).
    expect(onApplyXAxis.mock.calls[0][0]).toEqual({
      timeRange: 'custom',
      timeFrom: toDatetimeLocal(center - 30 * MIN),
      timeTo: toDatetimeLocal(center + 30 * MIN),
    });
  });

  it('a 30 s current span still yields From < To, a whole minute apart', () => {
    const view = { fromNs: msToNs(T0 - 30_000), toNs: msToNs(T0) };
    const { onApplyXAxis } = setup({ viewWindowNs: view });
    const center = new Date(2026, 9, 10, 8, 30).getTime();
    fireEvent.change(goto(), { target: { value: toDatetimeLocal(center) } });
    fireEvent.keyDown(goto(), { key: 'Enter' });
    const x = onApplyXAxis.mock.calls[0][0];
    const from = new Date(x.timeFrom!).getTime();
    const to = new Date(x.timeTo!).getTime();
    expect(from).toBeLessThan(to);
    expect(from % MIN).toBe(0);
    expect(to % MIN).toBe(0);
    expect(from).toBeLessThanOrEqual(center - 15_000);
    expect(to).toBeGreaterThanOrEqual(center + 15_000);
  });

  it('goToXAxis floors From and ceils To to whole minutes, at least one minute apart', () => {
    const c = new Date(2026, 9, 10, 8, 30, 20).getTime();
    const a = goToXAxis(X, c, 90_000); // 08:29:35 .. 08:31:05
    expect(a.timeFrom).toBe(toDatetimeLocal(new Date(2026, 9, 10, 8, 29).getTime()));
    expect(a.timeTo).toBe(toDatetimeLocal(new Date(2026, 9, 10, 8, 32).getTime()));
    const z = goToXAxis(X, new Date(2026, 9, 10, 8, 30).getTime(), 0);
    expect(new Date(z.timeTo!).getTime() - new Date(z.timeFrom!).getTime()).toBe(MIN);
  });

  it('stops native pointerdown/mousedown so a press never starts a plot gesture', () => {
    setup();
    const outer = vi.fn();
    document.body.addEventListener('pointerdown', outer);
    document.body.addEventListener('mousedown', outer);
    fireEvent.pointerDown(chip('now'));
    fireEvent.mouseDown(chip('now'));
    document.body.removeEventListener('pointerdown', outer);
    document.body.removeEventListener('mousedown', outer);
    expect(outer).not.toHaveBeenCalled();
  });
});
