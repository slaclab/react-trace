// @vitest-environment jsdom
//
// Pins issue 116: when the browser blocks the pop-up, DetachedWindow must tell
// its parent (onBlocked) as well as reattaching (onClose), so the user can be
// told why nothing opened.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { setColorMode } from '@slaclab/canopy-shell';
import { memoryStorage } from '../test/dom';
import { setupColorMode } from '../state/colorMode';
import { DetachedWindow } from './DetachedWindow';

// A stand-in pop-up: a separate document plus the Window members DetachedWindow uses.
function fakePopup() {
  const doc = document.implementation.createHTMLDocument('popup');
  return {
    document: doc,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  } as unknown as Window;
}

describe('DetachedWindow', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports a blocked pop-up and reattaches', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onBlocked = vi.fn();
    const onClose = vi.fn();
    render(
      <DetachedWindow name="w" title="Plot 1" onClose={onClose} onBlocked={onBlocked}>
        <span>plot</span>
      </DetachedWindow>
    );
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not report a block when the pop-up opens', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const onBlocked = vi.fn();
    const onClose = vi.fn();
    render(
      <DetachedWindow name="w" title="Plot 1" onClose={onClose} onBlocked={onBlocked}>
        <span>plot</span>
      </DetachedWindow>
    );
    await waitFor(() => expect(popup.document.body.textContent).toContain('plot'));
    expect(onBlocked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("themes the pop-up's page and follows a later colour-mode change", async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    setupColorMode(); // nothing stored: dark
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    render(
      <DetachedWindow name="w" title="Plot 1" onClose={vi.fn()}>
        <span>plot</span>
      </DetachedWindow>
    );
    await waitFor(() => expect(popup.document.body.textContent).toContain('plot'));
    const html = popup.document.documentElement;
    expect(html.dataset.theme).toBe('dark');
    expect(html.classList.contains('cds--g100')).toBe(true);

    act(() => setColorMode('light'));

    expect(html.dataset.theme).toBe('light');
    expect(html.classList.contains('cds--g10')).toBe(true);
    expect(html.classList.contains('cds--g100')).toBe(false);
  });
});
