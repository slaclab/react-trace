// @vitest-environment jsdom
//
// The Metrics list editor on its own (MetricsControl.tsx, over Correlation's catalog): the field's `#id`
// on the list, the row error mark of an invalid custom expression, Escape
// restoring the committed text, a refused empty label, one expanded row at a
// time, Add disabled with the reason at the cap, and the expression reference.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { defaultMetrics, type Metric } from './model';
import { FUNCTION_REFERENCE } from './expr';
import { MAX_METRICS, metricsFullMessage } from './model';
import { MetricsControl } from './MetricsControl';

afterEach(cleanup);

const custom = (id: string, label: string, expr: string): Metric => ({
  id,
  label,
  expr,
  unit: '',
  on: true,
  strip: false,
});

function mount(initial: Metric[], yCount = 2) {
  const writes: Metric[][] = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <MetricsControl
        id="metrics"
        value={value}
        catalog={CORRELATION_METRICS}
        rowCount={yCount}
        onChange={(next) => {
          writes.push(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return writes;
}

const button = (name: string) => screen.getByRole('button', { name });

describe('MetricsControl', () => {
  it('carries the field id on the list and one row per metric', () => {
    mount(defaultMetrics(CORRELATION_METRICS));
    const list = document.getElementById('metrics');
    expect(list?.tagName).toBe('UL');
    expect(list?.querySelectorAll('li')).toHaveLength(defaultMetrics(CORRELATION_METRICS).length);
  });

  it('marks a custom metric whose expression does not validate', () => {
    mount([
      ...defaultMetrics(CORRELATION_METRICS),
      custom('c1', 'bad', 'mean(y9)'),
      custom('c2', 'ok', 'max(y)'),
    ]);
    expect(
      screen.getByRole('img', { name: 'bad: Unknown variable y9: only 2 Y PVs' })
    ).toBeTruthy();
    expect(screen.queryByRole('img', { name: /^ok:/ })).toBeNull();
  });

  it('Escape restores the committed expression and writes nothing', () => {
    const writes = mount([custom('c1', 'drift', 'slope(t, y)')]);
    fireEvent.click(button('Edit drift'));
    const input = document.getElementById('metrics-c1-expr') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'mean(' } });
    // Uncommitted: a warning, never Carbon's red invalid state.
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(
      input.closest('.cds--text-input-wrapper')?.querySelector('.cds--form-requirement')
    ).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('slope(t, y)');
    fireEvent.blur(input);
    expect(writes).toHaveLength(0);
  });

  it('warns while typing and turns invalid once a commit leaves the expression bad', () => {
    const writes = mount([custom('c1', 'drift', 'slope(t, y)')]);
    fireEvent.click(button('Edit drift'));
    const input = document.getElementById('metrics-c1-expr') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'mean(y3' } });
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(input.classList.contains('cds--text-input--warning')).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(writes.at(-1)?.[0].expr).toBe('mean(y3');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.classList.contains('cds--text-input--warning')).toBe(false);
    fireEvent.change(input, { target: { value: 'mean(y' } });
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('refuses an empty label and commits a new one trimmed', () => {
    const writes = mount([custom('c1', 'drift', 'slope(t, y)')]);
    fireEvent.click(button('Edit drift'));
    const input = document.getElementById('metrics-c1-label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Enter a label')).toBeTruthy();
    expect(writes).toHaveLength(0);
    fireEvent.change(input, { target: { value: ' noise ' } });
    fireEvent.blur(input);
    expect(writes.at(-1)?.[0].label).toBe('noise');
  });

  it('expands one row at a time', () => {
    mount(defaultMetrics(CORRELATION_METRICS));
    fireEvent.click(button('Edit mean'));
    fireEvent.click(button('Edit std'));
    expect(screen.queryByRole('button', { name: 'Collapse mean' })).toBeNull();
    fireEvent.click(button('Collapse std'));
    expect(screen.queryByRole('button', { name: 'Move up' })).toBeNull();
  });

  it('disables Add metric with the reason at the cap', () => {
    const full = [
      ...defaultMetrics(CORRELATION_METRICS),
      ...Array.from({ length: MAX_METRICS - defaultMetrics(CORRELATION_METRICS).length }, (_, i) =>
        custom(`c${i + 1}`, `m${i + 1}`, 'mean(y)')
      ),
    ];
    mount(full);
    expect((button('Add metric') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(metricsFullMessage())).toBeTruthy();
  });

  it('deletes a built-in metric to make room for another of your own', () => {
    const full = [
      ...defaultMetrics(CORRELATION_METRICS),
      ...Array.from({ length: MAX_METRICS - defaultMetrics(CORRELATION_METRICS).length }, (_, i) =>
        custom(`c${i + 1}`, `m${i + 1}`, 'mean(y)')
      ),
    ];
    const writes = mount(full);
    fireEvent.click(button('Edit intercept'));
    fireEvent.click(button('Delete intercept'));
    expect(writes.at(-1)?.map((m) => m.id)).not.toContain('intercept');
    fireEvent.click(button('Add metric'));
    expect(writes.at(-1)).toHaveLength(MAX_METRICS);
    expect(writes.at(-1)?.at(-1)).toMatchObject({ id: 'c4', label: 'Metric 4' });
  });

  it('numbers a new metric after the existing customs', () => {
    const writes = mount([custom('c2', 'drift', 'slope(t, y)')]);
    fireEvent.click(button('Add metric'));
    expect(writes.at(-1)?.at(-1)).toMatchObject({ id: 'c3', label: 'Metric 2' });
  });

  it('lists every variable and function in the expression reference', () => {
    mount(defaultMetrics(CORRELATION_METRICS));
    expect(screen.getByText('Expression reference')).toBeTruthy();
    const terms = [...document.querySelectorAll('.stats-metrics__reference dt')].map(
      (dt) => dt.textContent
    );
    expect(terms).toEqual(
      [...CORRELATION_METRICS.variables, ...FUNCTION_REFERENCE].map((e) => e.signature)
    );
  });
});
