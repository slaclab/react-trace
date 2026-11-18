// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getColorMode, setColorMode } from '@slaclab/canopy-shell/color-mode';
import { memoryStorage } from '../test/dom';
import indexHtml from '../../index.html?raw';
import { TRACE_COLOR_MODE, setupColorMode } from './colorMode';

let storage: Storage;

// The part of an <html> the colour mode owns: data-theme and the Carbon classes.
function colorModeAttributes(html: HTMLElement) {
  return {
    theme: html.dataset.theme,
    carbon: Array.from(html.classList).filter((c) => c.startsWith('cds--')),
  };
}

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setupColorMode', () => {
  it('keeps the trace.theme key and the dark default', () => {
    expect(TRACE_COLOR_MODE).toEqual({ storageKey: 'trace.theme', defaultMode: 'dark' });
  });

  it("honors an existing user's stored light choice and paints <html> g10", () => {
    storage.setItem('trace.theme', 'light');
    setupColorMode();
    expect(getColorMode()).toBe('light');
    expect(document.documentElement.classList.contains('cds--g10')).toBe(true);
    expect(document.documentElement.classList.contains('cds--g100')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('defaults to dark (g100) when nothing is stored', () => {
    setupColorMode();
    expect(getColorMode()).toBe('dark');
    expect(document.documentElement.classList.contains('cds--g100')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores an invalid stored value', () => {
    storage.setItem('trace.theme', 'sepia');
    setupColorMode();
    expect(getColorMode()).toBe('dark');
  });

  it('persists a new choice under trace.theme', () => {
    setupColorMode();
    setColorMode('light');
    expect(storage.getItem('trace.theme')).toBe('light');
  });
});

describe('index.html', () => {
  it('pre-paints <html> as setupColorMode paints it for a new user', () => {
    // index.html's attributes cover the first paint before main.tsx runs; they
    // must match TRACE_COLOR_MODE.defaultMode or new users see the wrong theme flash.
    setupColorMode(); // nothing stored
    const prePaint = new DOMParser().parseFromString(indexHtml, 'text/html').documentElement;
    expect(colorModeAttributes(prePaint)).toEqual(colorModeAttributes(document.documentElement));
  });
});
