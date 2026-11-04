// @vitest-environment jsdom
//
// The shared PV field: suggestions from the catalog and the injected search,
// a commit on a pick or on Enter only, the helper line, and the cancel paths
// (Escape, leaving the field empty) the on-demand callers rely on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PvCombo, type PvComboProps } from './PvCombo';

const CATALOG = ['SIM:BPM1:X', 'SIM:BPM2:X', 'SIM:MAG:QF1:CURRENT'];

function mount(over: Partial<PvComboProps> = {}) {
  const props = {
    id: 'pv',
    value: '',
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    search: vi.fn(async () => [] as string[]),
    catalog: CATALOG,
    ...over,
  };
  const view = render(<PvCombo {...props} />);
  // Named by its title, not Carbon's default "Choose an item".
  const input = screen.getByRole('combobox', { name: 'PV name' }) as HTMLInputElement;
  return { ...props, ...view, input };
}

async function settle(ms = 300) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function options(): string[] {
  return screen.queryAllByRole('option').map((o) => o.textContent ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PvCombo suggestions', () => {
  it('searches the typed text after the debounce and lists catalog matches first', async () => {
    const search = vi.fn(async () => ['SIM:BPM2:X', 'SIM:BPM9:ARCHIVED']);
    const { input } = mount({ search });
    fireEvent.change(input, { target: { value: 'bpm' } });
    expect(search).not.toHaveBeenCalled();
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('bpm', expect.any(AbortSignal));
    expect(options()).toEqual(['SIM:BPM1:X', 'SIM:BPM2:X', 'SIM:BPM9:ARCHIVED']);
    expect(screen.getByText('3 matches')).toBeTruthy();
  });

  it('reports a failed search and still lists the catalog matches', async () => {
    const search = vi.fn(async () => {
      throw Object.assign(new Error('down'), { code: 'archiver_unavailable' });
    });
    const { input } = mount({ search });
    fireEvent.change(input, { target: { value: 'qf1' } });
    await settle();
    expect(options()).toEqual(['SIM:MAG:QF1:CURRENT']);
    expect(screen.getByText('Search failed: archiver_unavailable')).toBeTruthy();
  });

  it('does not search the committed value itself', async () => {
    const { search } = mount({ value: 'SIM:BPM1:X' });
    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByText(/match/)).toBeNull();
  });

  it('reseeds the text from a new committed value', () => {
    const { input, rerender, onCommit, onCancel, search } = mount({ value: 'SIM:A' });
    expect(input.value).toBe('SIM:A');
    rerender(
      <PvCombo
        id="pv"
        value="SIM:B"
        onCommit={onCommit}
        onCancel={onCancel}
        search={search}
        catalog={CATALOG}
      />
    );
    expect(input.value).toBe('SIM:B');
  });
});

describe('PvCombo commit', () => {
  it('commits a picked suggestion, and nothing per keystroke', async () => {
    const { input, onCommit } = mount();
    fireEvent.change(input, { target: { value: 'bpm' } });
    await settle();
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'SIM:BPM2:X' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('SIM:BPM2:X');
  });

  it('commits the typed text on Enter', async () => {
    const { input, onCommit } = mount();
    fireEvent.change(input, { target: { value: 'TEST:NEW:PV ' } });
    await settle();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('TEST:NEW:PV');
  });

  it('commits nothing on Enter in an empty field', () => {
    const { input, onCommit } = mount();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('PvCombo cancel', () => {
  it('cancels on Escape', () => {
    const { input, onCancel } = mount();
    fireEvent.change(input, { target: { value: 'bp' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels when the field is left empty; left with text, it commits the text', () => {
    const { input, onCancel, onCommit } = mount();
    fireEvent.change(input, { target: { value: 'TEST:X' } });
    fireEvent.blur(input);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith('TEST:X');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('without commitOnBlur, leaving the field with text commits nothing', async () => {
    const { input, onCommit } = mount({ commitOnBlur: false });
    fireEvent.change(input, { target: { value: 'TEST:X' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    // Enter still commits.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'TEST:Y' } });
    await settle();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('TEST:Y');
  });
});
