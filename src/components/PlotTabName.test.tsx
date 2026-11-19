// @vitest-environment jsdom
//
// Renaming a plot from its tab: double-click the name, then Enter or a click
// away keeps the new name, Escape keeps the old one, and an empty name keeps
// the old one too.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlotTabName, PLOT_NAME_MAX } from './PlotTabName';

afterEach(cleanup);

function setup(title = 'Plot 1') {
  const onRename = vi.fn();
  render(<PlotTabName title={title} onRename={onRename} />);
  fireEvent.doubleClick(screen.getByText(title));
  const input = screen.getByRole('textbox', { name: 'Plot name' }) as HTMLInputElement;
  return { onRename, input };
}

describe('renaming a plot from its tab', () => {
  it('shows the name as text until it is double-clicked', () => {
    render(<PlotTabName title="Plot 1" onRename={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Plot 1').getAttribute('title')).toBe('Double-click to rename');
  });

  it('opens an input holding the current name, focused', () => {
    const { input } = setup();
    expect(input.value).toBe('Plot 1');
    expect(document.activeElement).toBe(input);
    expect(input.maxLength).toBe(PLOT_NAME_MAX);
  });

  it('Enter keeps the new name, trimmed', () => {
    const { onRename, input } = setup();
    fireEvent.change(input, { target: { value: '  Beam current  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Beam current');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a click away keeps the new name', () => {
    const { onRename, input } = setup();
    fireEvent.change(input, { target: { value: 'Orbit' } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Orbit');
  });

  it('Escape keeps the old name and goes no further', () => {
    const outer = vi.fn();
    const onRename = vi.fn();
    render(
      <div onKeyDown={outer}>
        <PlotTabName title="Plot 1" onRename={onRename} />
      </div>
    );
    fireEvent.doubleClick(screen.getByText('Plot 1'));
    const input = screen.getByRole('textbox', { name: 'Plot name' });
    fireEvent.change(input, { target: { value: 'Orbit' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByText('Plot 1')).toBeTruthy();
  });

  it('an empty name, or the same name, renames nothing', () => {
    const { onRename, input } = setup();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByText('Plot 1'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Plot name' }), { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('without a rename handler the name is plain text', () => {
    render(<PlotTabName title="Plot 1" />);
    fireEvent.doubleClick(screen.getByText('Plot 1'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
