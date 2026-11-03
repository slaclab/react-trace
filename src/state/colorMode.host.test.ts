// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shell's colour-mode store and Trace's host theme keep module-level
// state, so every test sets the URL first, imports fresh copies and runs the
// page's setup. The React testing helpers are imported after the same reset so
// that they and the stores share one React instance.
type Shell = typeof import('@slaclab/canopy-shell/color-mode');
type Host = typeof import('./colorMode');
type Theme = Pick<Shell, 'getColorMode' | 'setColorMode'> &
  Pick<Host, 'getHostThemeId' | 'setHostTheme' | 'useHostThemeId' | 'subscribeHostThemeId'>;
type Rtl = typeof import('@testing-library/react');

async function load(search: string): Promise<Theme> {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  const shell = await import('@slaclab/canopy-shell/color-mode');
  const host = await import('./colorMode');
  host.setupColorMode();
  return {
    getColorMode: shell.getColorMode,
    setColorMode: shell.setColorMode,
    getHostThemeId: host.getHostThemeId,
    setHostTheme: host.setHostTheme,
    useHostThemeId: host.useHostThemeId,
    subscribeHostThemeId: host.subscribeHostThemeId,
  };
}

let rtl: Rtl | undefined;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  rtl?.cleanup();
  rtl = undefined;
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('initial host theme', () => {
  it('has no host theme id and the default mode without ?theme=', async () => {
    const theme = await load('?embedded=true');
    expect(theme.getHostThemeId()).toBeNull();
    expect(theme.getColorMode()).toBe('dark');
  });

  it('takes a valid ?theme= as the id', async () => {
    const theme = await load('?embedded=true&theme=retro-dark');
    expect(theme.getHostThemeId()).toBe('retro-dark');
    expect(theme.getColorMode()).toBe('dark');
  });

  it("derives the mode from the id with the shell's rule", async () => {
    const theme = await load('?embedded=true&theme=solarized-light');
    expect(theme.getHostThemeId()).toBe('solarized-light');
    expect(theme.getColorMode()).toBe('light');
  });

  it('keeps the two bare modes working as ids', async () => {
    const theme = await load('?embedded=true&theme=light');
    expect(theme.getHostThemeId()).toBe('light');
    expect(theme.getColorMode()).toBe('light');
  });

  it.each(['../x', 'Retro-Dark', '', 'a'.repeat(41)])(
    'rejects the invalid ?theme=%j',
    async (bad) => {
      const theme = await load(`?embedded=true&theme=${encodeURIComponent(bad)}`);
      expect(theme.getHostThemeId()).toBeNull();
      expect(theme.getColorMode()).toBe('dark');
    }
  );

  it('ignores ?theme= when not embedded', async () => {
    window.localStorage.setItem('trace.theme', 'light');
    const theme = await load('?theme=retro-dark');
    expect(theme.getHostThemeId()).toBeNull();
    expect(theme.getColorMode()).toBe('light');
  });
});

describe('setHostTheme', () => {
  it('applies the id and the mode together', async () => {
    const theme = await load('?embedded=true&theme=retro-dark');
    theme.setHostTheme('solarized-light', 'light');
    expect(theme.getHostThemeId()).toBe('solarized-light');
    expect(theme.getColorMode()).toBe('light');
  });

  it('tells id listeners about an id change only', async () => {
    const theme = await load('?embedded=true&theme=desy-dark');
    const listener = vi.fn();
    const unsubscribe = theme.subscribeHostThemeId(listener);
    theme.setHostTheme('retro-dark', 'dark');
    expect(theme.getHostThemeId()).toBe('retro-dark');
    expect(listener).toHaveBeenCalledTimes(1);
    theme.setHostTheme('retro-dark', 'light');
    expect(listener).toHaveBeenCalledTimes(1);
    theme.setHostTheme(null, 'light');
    expect(theme.getHostThemeId()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    theme.setHostTheme('retro-dark', 'dark');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never reads or writes Trace's stored choice", async () => {
    const theme = await load('?embedded=true');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    theme.setHostTheme('solarized-light', 'light');
    expect(getItem).not.toHaveBeenCalledWith('trace.theme');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('wins over a toggle made since the last host message', async () => {
    const theme = await load('?embedded=true&theme=retro-dark');
    theme.setColorMode('light');
    theme.setHostTheme('retro-dark', 'dark');
    expect(theme.getColorMode()).toBe('dark');
  });

  it('leaves the id alone when only the mode is set', async () => {
    const theme = await load('?embedded=true&theme=retro-dark');
    theme.setColorMode('light');
    expect(theme.getHostThemeId()).toBe('retro-dark');
    expect(theme.getColorMode()).toBe('light');
  });
});

describe('useHostThemeId', () => {
  it('returns the id and re-renders on a same-mode id change', async () => {
    const theme = await load('?embedded=true&theme=desy-dark');
    rtl = await import('@testing-library/react');
    const { result } = rtl.renderHook(() => theme.useHostThemeId());
    expect(result.current).toBe('desy-dark');
    rtl.act(() => theme.setHostTheme('retro-dark', 'dark'));
    expect(result.current).toBe('retro-dark');
    rtl.act(() => theme.setHostTheme(null, 'dark'));
    expect(result.current).toBeNull();
  });
});
