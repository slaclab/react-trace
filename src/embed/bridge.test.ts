// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bridge, the shell's colour-mode store and Trace's host theme keep
// module-level state, so every test sets the URL first, imports fresh copies
// and runs the page's colour-mode setup.
type Bridge = typeof import('./bridge');
type Shell = typeof import('@slaclab/canopy-shell/color-mode');
type Host = typeof import('../state/colorMode');
type Theme = Pick<Shell, 'getColorMode' | 'setColorMode' | 'toggleColorMode'> &
  Pick<Host, 'getHostThemeId'> & { subscribeTheme: Host['subscribeHostThemeId'] };

async function load(search: string): Promise<{ bridge: Bridge; theme: Theme }> {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  const shell = await import('@slaclab/canopy-shell/color-mode');
  const host = await import('../state/colorMode');
  host.setupColorMode();
  const bridge = await import('./bridge');
  const theme: Theme = {
    getColorMode: shell.getColorMode,
    setColorMode: shell.setColorMode,
    toggleColorMode: shell.toggleColorMode,
    getHostThemeId: host.getHostThemeId,
    subscribeTheme: host.subscribeHostThemeId,
  };
  return { bridge, theme };
}

function fromParent(data: unknown, origin = location.origin): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: window.parent }));
}

let uninstall: (() => void) | undefined;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('installBridge', () => {
  it('posts trace-ready to the parent after the listener is installed', async () => {
    const { bridge } = await load('?embedded=true');
    const order: string[] = [];
    const original = window.addEventListener.bind(window);
    const addSpy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((...args: Parameters<Window['addEventListener']>) => {
        if (args[0] === 'message') order.push('listen');
        original(...args);
      });
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {
      order.push('ready');
    });
    uninstall = bridge.installBridge();
    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: 'canopy:trace-ready' }, location.origin);
    expect(order).toEqual(['listen', 'ready']);
  });

  it('installs nothing and posts nothing when not embedded', async () => {
    const { bridge } = await load('');
    const addSpy = vi.spyOn(window, 'addEventListener');
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    expect(addSpy.mock.calls.filter((c) => c[0] === 'message')).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    expect(bridge.getSnapshot().visible).toBe(true);
  });

  it('installs one listener even when called twice', async () => {
    const { bridge } = await load('?embedded=true');
    const addSpy = vi.spyOn(window, 'addEventListener');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    bridge.installBridge();
    expect(addSpy.mock.calls.filter((c) => c[0] === 'message')).toHaveLength(1);
  });
});

describe('bridge snapshot', () => {
  async function installed(search = '?embedded=true'): Promise<{ bridge: Bridge; theme: Theme }> {
    const mods = await load(search);
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = mods.bridge.installBridge();
    return mods;
  }

  it('defaults to visible with no hiddenAt and no mode', async () => {
    const { bridge } = await installed();
    expect(bridge.getSnapshot()).toEqual({ visible: true });
  });

  it('ignores a message from a foreign source', async () => {
    const { bridge } = await installed();
    const other = { postMessage: () => {} } as unknown as Window;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'canopy:trace-visibility', visible: false },
        origin: location.origin,
        source: other as MessageEventSource,
      })
    );
    expect(bridge.getSnapshot().visible).toBe(true);
  });

  it('ignores a message from a foreign origin', async () => {
    const { bridge } = await installed();
    fromParent({ type: 'canopy:trace-visibility', visible: false }, 'http://evil.example');
    expect(bridge.getSnapshot().visible).toBe(true);
  });

  it("ignores a mode other than the two literals (mode:'blue')", async () => {
    const { bridge, theme } = await installed();
    const listener = vi.fn();
    bridge.subscribe(listener);
    const before = theme.getColorMode();
    fromParent({ type: 'canopy:trace-theme', mode: 'blue' });
    expect(bridge.getSnapshot().mode).toBeUndefined();
    expect(theme.getColorMode()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores malformed payloads', async () => {
    const { bridge } = await installed();
    const listener = vi.fn();
    bridge.subscribe(listener);
    for (const data of [
      null,
      'x',
      42,
      {},
      { type: 'canopy:trace-visibility' },
      { type: 'canopy:trace-visibility', visible: 'false' },
      { type: 'other', visible: false },
    ]) {
      fromParent(data);
    }
    expect(bridge.getSnapshot()).toEqual({ visible: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('a message before subscribe reaches a later subscriber', async () => {
    const { bridge } = await installed();
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    fromParent({ type: 'canopy:trace-theme', mode: 'light' });
    const listener = vi.fn();
    bridge.subscribe(listener);
    const snap = bridge.getSnapshot();
    expect(snap.visible).toBe(false);
    expect(snap.mode).toBe('light');
    expect(typeof snap.hiddenAt).toBe('number');
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const { bridge } = await installed();
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe(listener);
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stamps hiddenAt on visible->hidden and a repeated hidden message keeps it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { bridge } = await installed();
    const listener = vi.fn();
    bridge.subscribe(listener);
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    const first = bridge.getSnapshot();
    expect(first).toEqual({ visible: false, hiddenAt: 1_000_000 });

    vi.setSystemTime(1_060_000);
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    expect(bridge.getSnapshot().hiddenAt).toBe(1_000_000);
    // Unchanged state keeps the same reference, as useSyncExternalStore needs.
    expect(bridge.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(bridge.getSnapshot()).toEqual({ visible: true });

    vi.setSystemTime(2_000_000);
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    expect(bridge.getSnapshot().hiddenAt).toBe(2_000_000);
  });

  it('getSnapshot is stable between calls', async () => {
    const { bridge } = await installed();
    expect(bridge.getSnapshot()).toBe(bridge.getSnapshot());
  });
});

describe('embedded theme', () => {
  it("takes the initial mode from ?theme= and leaves Trace's stored choice alone", async () => {
    window.localStorage.setItem('trace.theme', 'dark');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { theme } = await load('?embedded=true&theme=light');
    expect(theme.getColorMode()).toBe('light');
    theme.toggleColorMode();
    theme.setColorMode('light');
    // The hosted store runs under its own key; Trace's key stays untouched.
    expect(getItem).not.toHaveBeenCalledWith('trace.theme');
    expect(setItem).not.toHaveBeenCalledWith('trace.theme', expect.anything());
    expect(window.localStorage.getItem('trace.theme')).toBe('dark');
  });

  it("follows the bridge theme and leaves Trace's stored choice alone", async () => {
    const { bridge, theme } = await load('?embedded=true&theme=dark');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    expect(theme.getColorMode()).toBe('dark');
    fromParent({ type: 'canopy:trace-theme', mode: 'light' });
    expect(theme.getColorMode()).toBe('light');
    expect(bridge.getSnapshot().mode).toBe('light');
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalledWith('trace.theme');
    expect(window.localStorage.getItem('trace.theme')).toBeNull();
  });

  it('ignores an invalid ?theme= when embedded and falls back to the default', async () => {
    const { theme } = await load('?embedded=true&theme=../x');
    expect(theme.getColorMode()).toBe('dark');
    expect(theme.getHostThemeId()).toBeNull();
  });

  it('has no host theme id without ?theme=', async () => {
    const { theme } = await load('?embedded=true');
    expect(theme.getHostThemeId()).toBeNull();
  });

  it('takes the host theme id from a theme message', async () => {
    const { bridge, theme } = await load('?embedded=true');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    fromParent({ type: 'canopy:trace-theme', mode: 'dark', theme: 'retro-dark' });
    expect(theme.getHostThemeId()).toBe('retro-dark');
    expect(theme.getColorMode()).toBe('dark');
    expect(bridge.getSnapshot().mode).toBe('dark');
  });

  it('drops an invalid theme id from a theme message but keeps its mode', async () => {
    const { bridge, theme } = await load('?embedded=true&theme=retro-dark');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    expect(theme.getHostThemeId()).toBe('retro-dark');
    fromParent({ type: 'canopy:trace-theme', mode: 'light', theme: '../x' });
    expect(theme.getHostThemeId()).toBeNull();
    expect(theme.getColorMode()).toBe('light');
  });

  it('clears the host theme id on a theme message without one, or with a non-string', async () => {
    const { bridge, theme } = await load('?embedded=true&theme=retro-dark');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    fromParent({ type: 'canopy:trace-theme', mode: 'dark' });
    expect(theme.getHostThemeId()).toBeNull();
    fromParent({ type: 'canopy:trace-theme', mode: 'dark', theme: 'desy-dark' });
    expect(theme.getHostThemeId()).toBe('desy-dark');
    // `RegExp.test(null)` is true (it tests the string 'null'): must not leak.
    fromParent({ type: 'canopy:trace-theme', mode: 'dark', theme: null });
    expect(theme.getHostThemeId()).toBeNull();
  });

  it('same-mode id change updates hostThemeId', async () => {
    const { bridge, theme } = await load('?embedded=true');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    fromParent({ type: 'canopy:trace-theme', mode: 'dark', theme: 'desy-dark' });
    expect(theme.getHostThemeId()).toBe('desy-dark');
    const listener = vi.fn();
    theme.subscribeTheme(listener);
    fromParent({ type: 'canopy:trace-theme', mode: 'dark', theme: 'retro-dark' });
    expect(theme.getHostThemeId()).toBe('retro-dark');
    expect(theme.getColorMode()).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps using localStorage when not embedded', async () => {
    window.localStorage.setItem('trace.theme', 'light');
    const { theme } = await load('?theme=dark');
    expect(theme.getColorMode()).toBe('light');
    theme.setColorMode('dark');
    expect(window.localStorage.getItem('trace.theme')).toBe('dark');
  });
});

describe('everVisible latch', () => {
  async function installed(): Promise<Bridge> {
    const { bridge } = await load('?embedded=true');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    uninstall = bridge.installBridge();
    return bridge;
  }

  it('starts unset although the snapshot starts visible', async () => {
    const bridge = await installed();
    expect(bridge.getSnapshot().visible).toBe(true);
    expect(bridge.getEverVisible()).toBe(false);
  });

  it('latches only on visible:true, never on visible:false or a theme', async () => {
    const bridge = await installed();
    const latch = vi.fn();
    bridge.subscribeEverVisible(latch);
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    fromParent({ type: 'canopy:trace-theme', mode: 'light' });
    fromParent({ type: 'canopy:trace-visibility', visible: 'true' });
    expect(bridge.getEverVisible()).toBe(false);
    expect(latch).not.toHaveBeenCalled();
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(bridge.getEverVisible()).toBe(true);
    expect(latch).toHaveBeenCalledTimes(1);
  });

  it('latches on a visible:true that does not change the snapshot', async () => {
    const bridge = await installed();
    const snapshotListener = vi.fn();
    bridge.subscribe(snapshotListener);
    const before = bridge.getSnapshot();
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(bridge.getEverVisible()).toBe(true);
    // Trace's snapshot behaviour is unchanged: no new snapshot, no notify.
    expect(bridge.getSnapshot()).toBe(before);
    expect(snapshotListener).not.toHaveBeenCalled();
  });

  it('visible:true, then hidden, then visible again keeps it set', async () => {
    const bridge = await installed();
    const latch = vi.fn();
    bridge.subscribeEverVisible(latch);
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    expect(bridge.getEverVisible()).toBe(true);
    expect(bridge.getSnapshot().visible).toBe(false);
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(bridge.getEverVisible()).toBe(true);
    expect(latch).toHaveBeenCalledTimes(1);
  });

  it('is never part of the snapshot', async () => {
    const bridge = await installed();
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    fromParent({ type: 'canopy:trace-visibility', visible: false });
    fromParent({ type: 'canopy:trace-theme', mode: 'dark' });
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(bridge.getSnapshot()).toEqual({ visible: true, mode: 'dark' });
  });

  it('ignores a visible:true from a foreign origin or when not embedded', async () => {
    const bridge = await installed();
    fromParent({ type: 'canopy:trace-visibility', visible: true }, 'http://evil.example');
    expect(bridge.getEverVisible()).toBe(false);

    const { bridge: standalone } = await load('');
    uninstall?.();
    uninstall = standalone.installBridge();
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(standalone.getEverVisible()).toBe(false);
  });

  it('stops notifying after unsubscribe', async () => {
    const bridge = await installed();
    const latch = vi.fn();
    bridge.subscribeEverVisible(latch)();
    fromParent({ type: 'canopy:trace-visibility', visible: true });
    expect(latch).not.toHaveBeenCalled();
    expect(bridge.getEverVisible()).toBe(true);
  });
});
