// @vitest-environment jsdom
//
// Pins the shared Time range preset list: `TIME_RANGE_PRESETS` is the one list
// the Properties field, the tab-bar chips and the time-band menu render from.
// It starts at Last 30 Seconds, carries `-6h` between `-4h` and `-1d`, and a
// preset range is a relative span, never `custom`, with no duplicate option.
// Last 1 Minute is `-1m`, so a typed `1m` span selects it rather than adding a
// separate "Last 1m" option, and spans accept seconds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { TIME_RANGE_PRESETS, TimeRangeControl, type TimeRangeValue } from './timeRange';

afterEach(cleanup);

const relative = (timeRange: string): TimeRangeValue => ({ timeRange }) as TimeRangeValue;

function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}

describe('TIME_RANGE_PRESETS', () => {
  it('lists -1h, -6h and -1d in that order, with -6h right after -4h', () => {
    const values = TIME_RANGE_PRESETS.map((preset) => preset.value);
    expect(values.indexOf('-1h')).toBeGreaterThanOrEqual(0);
    expect(values.indexOf('-1h')).toBeLessThan(values.indexOf('-6h'));
    expect(values.indexOf('-6h')).toBeLessThan(values.indexOf('-1d'));
    expect(values.indexOf('-6h')).toBe(values.indexOf('-4h') + 1);
    expect(values.indexOf('-1d')).toBe(values.indexOf('-6h') + 1);
  });

  it('labels -6h "Last 6 Hours" and keeps every value unique and relative', () => {
    expect(TIME_RANGE_PRESETS.find((preset) => preset.value === '-6h')?.label).toBe('Last 6 Hours');
    const values = TIME_RANGE_PRESETS.map((preset) => preset.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).not.toContain('custom');
    expect(values).toEqual([
      '-30s',
      '-1m',
      '-5m',
      '-15m',
      '-1h',
      '-4h',
      '-6h',
      '-1d',
      '-2d',
      '-1w',
      '-1M',
    ]);
  });

  it('offers the short strip-tool spans, Last 1 Minute stored as -1m', () => {
    const label = (value: string) => TIME_RANGE_PRESETS.find((p) => p.value === value)?.label;
    expect(label('-30s')).toBe('Last 30 Seconds');
    expect(label('-1m')).toBe('Last 1 Minute');
    expect(label('-5m')).toBe('Last 5 Minutes');
    expect(label('-15m')).toBe('Last 15 Minutes');
    expect(TIME_RANGE_PRESETS.map((p) => p.value)).not.toContain('-60s');
  });
});

describe('TimeRangeControl', () => {
  it('renders the shared presets in order, then Custom', () => {
    const { container } = render(
      <TimeRangeControl id="time-range" value={relative('-1h')} onChange={() => {}} />
    );
    const select = container.querySelector<HTMLSelectElement>('#time-range')!;
    expect(optionValues(select)).toEqual([
      ...TIME_RANGE_PRESETS.map((preset) => preset.value),
      'custom',
    ]);
  });

  it('selecting -6h commits a relative range, not custom', () => {
    const onChange = vi.fn();
    const { container } = render(
      <TimeRangeControl id="time-range" value={relative('-1h')} onChange={onChange} />
    );
    const select = container.querySelector<HTMLSelectElement>('#time-range')!;
    fireEvent.change(select, { target: { value: '-6h' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].timeRange).toBe('-6h');
    expect(onChange.mock.calls[0][0].timeRange).not.toBe('custom');
  });

  it('shows -6h as a preset: span input, no From/To, no extra option', () => {
    const { container } = render(
      <TimeRangeControl id="time-range" value={relative('-6h')} onChange={() => {}} />
    );
    const select = container.querySelector<HTMLSelectElement>('#time-range')!;
    expect(select.value).toBe('-6h');
    expect(optionValues(select).filter((v) => v === '-6h')).toHaveLength(1);
    expect(optionValues(select)).toHaveLength(TIME_RANGE_PRESETS.length + 1);
    expect(container.querySelector<HTMLInputElement>('#time-span')?.value).toBe('6h');
    expect(container.querySelector('#time-from')).toBeNull();
    expect(container.querySelector('#time-to')).toBeNull();
  });

  it('still gives a non-preset relative range its own option', () => {
    const { container } = render(
      <TimeRangeControl id="time-range" value={relative('-90m')} onChange={() => {}} />
    );
    const select = container.querySelector<HTMLSelectElement>('#time-range')!;
    expect(select.value).toBe('-90m');
    expect(optionValues(select)).toHaveLength(TIME_RANGE_PRESETS.length + 2);
  });

  it('selects Last 1 Minute for a -1m range, with no extra option', () => {
    const { container } = render(
      <TimeRangeControl id="time-range" value={relative('-1m')} onChange={() => {}} />
    );
    const select = container.querySelector<HTMLSelectElement>('#time-range')!;
    expect(select.value).toBe('-1m');
    expect(select.selectedOptions[0].textContent).toBe('Last 1 Minute');
    expect(optionValues(select).filter((v) => v === '-1m')).toHaveLength(1);
    expect(optionValues(select)).toHaveLength(TIME_RANGE_PRESETS.length + 1);
  });

  it('commits a typed 1m span as the -1m preset', () => {
    const onChange = vi.fn();
    const { container } = render(
      <TimeRangeControl id="time-range" value={relative('-1h')} onChange={onChange} />
    );
    const span = container.querySelector<HTMLInputElement>('#time-span')!;
    fireEvent.change(span, { target: { value: '1m' } });
    fireEvent.keyDown(span, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].timeRange).toBe('-1m');
  });

  it('accepts a span in seconds', () => {
    const onChange = vi.fn();
    const { container } = render(
      <TimeRangeControl id="time-range" value={relative('-1h')} onChange={onChange} />
    );
    const span = container.querySelector<HTMLInputElement>('#time-span')!;
    fireEvent.change(span, { target: { value: '90s' } });
    fireEvent.blur(span);
    expect(onChange.mock.calls[0][0].timeRange).toBe('-90s');
    expect(span.getAttribute('aria-invalid')).not.toBe('true');
  });
});
