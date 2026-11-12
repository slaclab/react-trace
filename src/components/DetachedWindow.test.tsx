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

// A document's <html> attributes as { name: value }, to compare two documents.
function htmlAttributes(doc: Document): Record<string, string> {
  return Object.fromEntries(Array.from(doc.documentElement.attributes, (a) => [a.name, a.value]));
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

  it("themes the pop-up's page like the opener's and follows a later colour-mode change", async () => {
    // The opener's <html> carries only what canopy-shell's syncDocumentColorMode
    // paints; the pop-up's must end up identical, so syncPopupTheme can't drift
    // from it on a canopy-shell upgrade.
    const opener = document.documentElement;
    opener.className = '';
    delete opener.dataset.theme;
    vi.stubGlobal('localStorage', memoryStorage());
    setupColorMode(); // nothing stored: dark
    const popup = fakePopup();
    const html = popup.document.documentElement;
    html.classList.add('cds--white', 'cds--g90'); // stale Carbon themes to clear
    vi.spyOn(window, 'open').mockReturnValue(popup);
    render(
      <DetachedWindow name="w" title="Plot 1" onClose={vi.fn()}>
        <span>plot</span>
      </DetachedWindow>
    );
    await waitFor(() => expect(popup.document.body.textContent).toContain('plot'));
    expect(html.dataset.theme).toBe('dark');
    expect(html.className).toBe('cds--g100');
    expect(htmlAttributes(popup.document)).toEqual(htmlAttributes(document));

    act(() => setColorMode('light'));

    expect(html.dataset.theme).toBe('light');
    expect(html.className).toBe('cds--g10');
    expect(htmlAttributes(popup.document)).toEqual(htmlAttributes(document));
  });
});
