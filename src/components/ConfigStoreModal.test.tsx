// @vitest-environment jsdom
//
// Pins ConfigStoreModal's async lifecycle (slaclab/react-trace#92). Save and
// every row's Load/Rename/Delete share one busy slot, so only one runs at a
// time. Save, Rename and Delete block all three of Carbon's dismissal paths (X,
// Escape, backdrop) until their server call settles; a Delete also keeps its
// confirmation dialog open until then. A Load doesn't block: dismissing aborts
// it and drops its result, even a response that beat the abort.
//
// Every magpie call returns a promise the test settles by hand, so each case
// controls exactly when a response lands relative to clicks and dismissals.
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ConfigStoreModal } from './ConfigStoreModal';
import { CanopyError } from '../api/client';
import type * as Magpie from '../api/magpie';
import type { ConfigDTO, PagedResult } from '../api/types';

const api = vi.hoisted(() => ({
  saveConfig: vi.fn<typeof Magpie.saveConfig>(),
  getConfig: vi.fn<typeof Magpie.getConfig>(),
  listConfigs: vi.fn<typeof Magpie.listConfigs>(),
  updateConfig: vi.fn<typeof Magpie.updateConfig>(),
  deleteConfig: vi.fn<typeof Magpie.deleteConfig>(),
}));
vi.mock('../api/magpie', () => api);
// The workspace codec isn't under test: Save sends {}, and Load spreads `data`
// over an empty workspace, so a config's `from` says which one was applied and
// its `warnings` (if any) reach the toast.
vi.mock('../io/serialize', () => ({
  serializeConfigData: () => ({}),
  deserializeConfigData: (data: object) => ({
    source: 'native',
    plots: [],
    warnings: [],
    ...data,
  }),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function config(slug: string, name: string, createdDate: string): ConfigDTO {
  return {
    id: `id-${slug}`,
    app: 'trace',
    slug,
    name,
    description: null,
    data: { from: slug },
    createdBy: null,
    createdDate,
    lastModifiedDate: createdDate,
  };
}

// The list renders newest first, so A is the first row.
const A = config('slug-a', 'Config A', '2026-10-02T00:00:00Z');
const B = config('slug-b', 'Config B', '2026-10-01T00:00:00Z');
const PAGE: PagedResult<ConfigDTO> = { results: [B, A], continuationToken: null, totalCount: 2 };

// Pending calls, in call order. getConfig doesn't reject on abort by itself:
// a test either settles it by hand (a response that beat the abort) or rejects
// it with an AbortError, as fetch would.
let loads: (Deferred<ConfigDTO> & { slug: string; signal: AbortSignal | undefined })[];
let saves: Deferred<ConfigDTO>[];
let renames: Deferred<ConfigDTO>[];
let deletes: Deferred<void>[];

const onLoaded = vi.fn();
const onToast = vi.fn();
const parentClose = vi.fn();

// Stands in for TraceApp: owns `open`, mounts the modal only while it's open,
// and has a toolbar button that can only set `open` to true.
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>toolbar-open</button>
      {open && (
        <ConfigStoreModal
          open={open}
          plots={[]}
          theme="light"
          onClose={() => {
            parentClose();
            setOpen(false);
          }}
          onLoaded={onLoaded}
          onToast={onToast}
        />
      )}
    </>
  );
}

// Run `fn`, then let every promise continuation and React update it triggers finish.
async function settle(fn: () => void = () => {}) {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  const result = render(<Harness />);
  await settle();
  return result;
}

async function reopen() {
  fireEvent.click(screen.getByText('toolbar-open'));
  await settle();
}

// The config store, or null once TraceApp has unmounted it.
function storeModal(): HTMLElement | null {
  return document.querySelector('.cds--modal:not(.cds--modal--danger)');
}

// The delete confirmation. It stays mounted, hidden, while the store is.
function confirmModal(): HTMLElement | null {
  return document.querySelector('.cds--modal--danger');
}

function shown(modal: HTMLElement | null): boolean {
  return modal?.classList.contains('is-visible') ?? false;
}

const storeOpen = () => shown(storeModal());
const confirmOpen = () => shown(confirmModal());

type RowAction = 'Load' | 'Rename' | 'Delete';
const ROW_ACTIONS: RowAction[] = ['Load', 'Rename', 'Delete'];

// `hidden: true` throughout: Carbon hides what's under a modal from the
// accessibility tree, including the store under the delete confirmation.
function rowButton(name: string, action: RowAction): HTMLButtonElement {
  const row = screen.getByText(name).closest('.cds--structured-list-row') as HTMLElement;
  return within(row).getByRole('button', { name: action, hidden: true }) as HTMLButtonElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /^(Save & copy share link|Saving…)$/,
    hidden: true,
  }) as HTMLButtonElement;
}

function allRowButtons(): HTMLButtonElement[] {
  return [A, B].flatMap((c) => ROW_ACTIONS.map((action) => rowButton(c.name!, action)));
}

// The confirmation's own Delete button, which starts the delete. Its
// accessible name starts with the danger description, so find it by class.
function confirmDeleteButton(): HTMLButtonElement {
  return confirmModal()!.querySelector('.cds--modal-footer .cds--btn--danger')!;
}

// A row's Delete, then the confirmation's.
function startDelete(name: string) {
  fireEvent.click(rowButton(name, 'Delete'));
  fireEvent.click(confirmDeleteButton());
}

// Start `action` on the row named `name`, through the confirmation for a Delete.
function startRowAction(name: string, action: RowAction) {
  if (action === 'Delete') startDelete(name);
  else fireEvent.click(rowButton(name, action));
}

const PATHS = ['X', 'Escape', 'backdrop'] as const;
type DismissPath = (typeof PATHS)[number];

// Dismiss the store. Escape goes to the topmost visible modal, as in Carbon.
function dismiss(path: DismissPath) {
  const store = storeModal()!;
  switch (path) {
    case 'X':
      fireEvent.click(within(store).getByRole('button', { name: 'Close', hidden: true }));
      break;
    case 'Escape':
      fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
      break;
    case 'backdrop':
      fireEvent.mouseDown(store);
      fireEvent.click(store);
      break;
  }
}

// The confirmation has a footer, so Carbon doesn't close it on a backdrop click.
const CONFIRM_PATHS = ['X', 'Escape', 'Cancel'] as const;
type ConfirmDismissPath = (typeof CONFIRM_PATHS)[number];

function dismissConfirm(path: ConfirmDismissPath) {
  const dialog = confirmModal()!;
  switch (path) {
    case 'X':
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close', hidden: true }));
      break;
    case 'Escape':
      fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
      break;
    case 'Cancel':
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel', hidden: true }));
      break;
  }
}

// jsdom has no clipboard API, so a Save's share-link copy normally fails at
// once. Cases that need a pending or rejected copy install one; afterEach
// removes it.
function stubClipboard(writeText: (text: string) => Promise<void>) {
  const clipboard = { writeText: vi.fn(writeText) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  return clipboard;
}

beforeAll(() => {
  // Carbon's icon-button tooltips observe their size; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  loads = [];
  saves = [];
  renames = [];
  deletes = [];
  api.listConfigs.mockResolvedValue(PAGE);
  api.getConfig.mockImplementation((slug, signal) => {
    const d = deferred<ConfigDTO>();
    loads.push({ ...d, slug, signal });
    return d.promise;
  });
  api.saveConfig.mockImplementation(() => {
    const d = deferred<ConfigDTO>();
    saves.push(d);
    return d.promise;
  });
  api.updateConfig.mockImplementation(() => {
    const d = deferred<ConfigDTO>();
    renames.push(d);
    return d.promise;
  });
  api.deleteConfig.mockImplementation(() => {
    const d = deferred<void>();
    deletes.push(d);
    return d.promise;
  });
  vi.spyOn(window, 'prompt').mockReturnValue('Renamed');
});

afterEach(() => {
  // No vitest globals, so RTL can't register its own cleanup.
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('ConfigStoreModal: one operation at a time', () => {
  it.each([
    ['B, then A', ['slug-b', 'slug-a']],
    ['A, then B', ['slug-a', 'slug-b']],
  ])('applies only the first of two Load clicks (responses %s)', async (_order, slugs) => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    fireEvent.click(rowButton('Config B', 'Load'));
    for (const slug of slugs) {
      const load = loads.find((l) => l.slug === slug);
      if (load) await settle(() => load.resolve(slug === A.slug ? A : B));
    }
    expect(api.getConfig.mock.calls.map(([slug]) => slug)).toEqual([A.slug]);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining(A.data));
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  // Inside one act() the second button is still enabled in the DOM, so only
  // the slot's ref can turn the click away.
  it.each(ROW_ACTIONS)(
    'starts only the Load when a %s click lands before React re-renders',
    async (action) => {
      await mount();
      act(() => {
        rowButton('Config A', 'Load').click();
        rowButton('Config B', action).click();
      });
      expect(api.getConfig.mock.calls.map(([slug]) => slug)).toEqual([A.slug]);
      expect(window.prompt).not.toHaveBeenCalled();
      expect(confirmOpen()).toBe(false);
    }
  );

  it('disables every row action and Save while a Load is in flight', async () => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    expect(allRowButtons().map((b) => b.disabled)).toEqual(Array(6).fill(true));
    expect(saveButton().disabled).toBe(true);
  });

  it('disables every row action while a Save is in flight', async () => {
    await mount();
    fireEvent.click(saveButton());
    expect(allRowButtons().map((b) => b.disabled)).toEqual(Array(6).fill(true));
  });

  it.each(['Rename', 'Delete'] as const)(
    'does not start a %s while a Load is in flight',
    async (action) => {
      await mount();
      fireEvent.click(rowButton('Config A', 'Load'));
      fireEvent.click(rowButton('Config B', action));
      expect(window.prompt).not.toHaveBeenCalled();
      expect(confirmOpen()).toBe(false);
      expect(api.updateConfig).not.toHaveBeenCalled();
      expect(api.deleteConfig).not.toHaveBeenCalled();
    }
  );

  it('does not start a Load while a Delete is in flight', async () => {
    await mount();
    startDelete('Config B');
    fireEvent.click(rowButton('Config A', 'Load'));
    expect(api.getConfig).not.toHaveBeenCalled();
  });

  // Before the fix the Rename ran, and its `finally` re-enabled A's Load while
  // the Load was still in flight. Now the Rename never starts.
  it("keeps A's Load disabled after a Rename click during it", async () => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    fireEvent.click(rowButton('Config B', 'Rename'));
    await settle(() => renames.forEach((r) => r.resolve(B)));
    expect(rowButton('Config A', 'Load').disabled).toBe(true);
  });

  it.each([
    ['Load', 'Loading "Config A"…'],
    ['Rename', 'Renaming "Config A"…'],
    ['Delete', 'Deleting "Config A"…'],
  ] as const)('shows a %s in the status line', async (action, status) => {
    await mount();
    startRowAction('Config A', action);
    expect(screen.queryByText(status)).not.toBeNull();
  });

  it('shows a Load failure and re-enables the row (control: passes before the fix too)', async () => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    await settle(() => loads[0].reject(new CanopyError('config_not_found', 404, 'not found')));
    expect(within(storeModal()!).queryByText('not found')).not.toBeNull();
    expect(rowButton('Config A', 'Load').disabled).toBe(false);
    expect(storeOpen()).toBe(true);
    expect(onLoaded).not.toHaveBeenCalled();
  });
});

describe('ConfigStoreModal: the Load toast', () => {
  it('closes after the usual timeout when the config loaded cleanly', async () => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    await settle(() => loads[0].resolve(A));
    expect(onToast).toHaveBeenCalledWith({
      kind: 'success',
      title: 'Workspace loaded',
      subtitle: 'Loaded "Config A"',
      timeout: undefined,
    });
  });

  it('lists the warnings and stays until dismissed when there are any', async () => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    const warnings = ['Skipped trace "X"', 'Unknown axis "Y"'];
    await settle(() => loads[0].resolve({ ...A, data: { from: A.slug, warnings } }));
    expect(onToast).toHaveBeenCalledWith({
      kind: 'success',
      title: 'Workspace loaded',
      subtitle: ['Loaded "Config A"', ...warnings].join('\n'),
      timeout: 0,
    });
  });
});

describe('ConfigStoreModal: dismissing cancels a Load', () => {
  it.each(PATHS)(
    'closes on %s during a Load and ignores a response that beat the abort',
    async (path) => {
      await mount();
      fireEvent.click(rowButton('Config A', 'Load'));
      dismiss(path);
      expect(storeOpen()).toBe(false);
      expect(parentClose).toHaveBeenCalledTimes(1);

      await settle(() => loads[0].resolve(A));
      expect(onLoaded).not.toHaveBeenCalled();
      expect(onToast).not.toHaveBeenCalled();
      expect(parentClose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(PATHS)('aborts the Load request on %s and reports nothing for it', async (path) => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    const { signal } = loads[0];
    dismiss(path);
    expect(signal?.aborted).toBe(true);

    await settle(() =>
      loads[0].reject(new DOMException('The operation was aborted.', 'AbortError'))
    );
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });

  // The dismissed Load's handler still runs when its response lands. If it
  // applied the workspace or called onClose, it would close the reopened modal.
  it("drops a dismissed Load's response after a reopen; the new Load still applies", async () => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    dismiss('Escape');
    await reopen();
    expect(storeOpen()).toBe(true);

    fireEvent.click(rowButton('Config A', 'Load'));
    await settle(() => loads[0].resolve(A));
    expect(onLoaded).not.toHaveBeenCalled();
    expect(storeOpen()).toBe(true);
    expect(parentClose).toHaveBeenCalledTimes(1);

    await settle(() => loads[1].resolve(A));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(storeOpen()).toBe(false);
  });

  it('aborts an in-flight Load on unmount and drops its response', async () => {
    const { unmount } = await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    const { signal } = loads[0];
    unmount();
    expect(signal?.aborted).toBe(true);
    await settle(() => loads[0].resolve(A));
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });
});

describe('ConfigStoreModal: Save, Rename and Delete block dismissal', () => {
  it.each(PATHS)(
    'blocks %s during a Save until its server call settles, then closes on it',
    async (path) => {
      await mount();
      fireEvent.click(saveButton());
      dismiss(path);
      expect(storeOpen()).toBe(true);
      expect(parentClose).not.toHaveBeenCalled();

      // Hold the list refresh that follows: only the server call blocks closing.
      const list = deferred<PagedResult<ConfigDTO>>();
      api.listConfigs.mockReturnValueOnce(list.promise);
      await settle(() => saves[0].resolve(config('slug-new', 'New', '2026-10-03T00:00:00Z')));
      expect(api.listConfigs).toHaveBeenCalledTimes(2);
      expect(saveButton().disabled).toBe(false);
      dismiss(path);
      expect(storeOpen()).toBe(false);
      expect(parentClose).toHaveBeenCalledTimes(1);
      await settle(() => list.resolve(PAGE));
    }
  );

  it.each(PATHS)(
    'blocks dismissal during a Rename (%s) until its server call settles, not the list refresh after it',
    async (path) => {
      await mount();
      fireEvent.click(rowButton('Config B', 'Rename'));
      dismiss(path);
      expect(storeOpen()).toBe(true);
      expect(parentClose).not.toHaveBeenCalled();

      // Hold the list refresh that follows: only the server call blocks closing.
      const list = deferred<PagedResult<ConfigDTO>>();
      api.listConfigs.mockReturnValueOnce(list.promise);
      await settle(() => renames[0].resolve(B));
      expect(api.listConfigs).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/^Renaming /)).toBeNull();
      dismiss(path);
      expect(storeOpen()).toBe(false);
      expect(parentClose).toHaveBeenCalledTimes(1);
      await settle(() => list.resolve(PAGE));
    }
  );

  // Carbon keeps the onClose from the render that opened the confirmation, so
  // a guard on render state would let Escape through mid-delete.
  it.each(CONFIRM_PATHS)(
    'keeps the delete confirmation open on %s until the Delete settles, then the store closes',
    async (path) => {
      await mount();
      startDelete('Config B');
      dismissConfirm(path);
      expect(confirmOpen()).toBe(true);
      expect(storeOpen()).toBe(true);
      expect(confirmDeleteButton().disabled).toBe(true);

      // Hold the list refresh that follows: only the server call blocks closing.
      const list = deferred<PagedResult<ConfigDTO>>();
      api.listConfigs.mockReturnValueOnce(list.promise);
      await settle(() => deletes[0].resolve());
      expect(confirmOpen()).toBe(false);
      expect(storeOpen()).toBe(true);
      expect(api.listConfigs).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/^Deleting /)).toBeNull();
      dismiss('Escape');
      expect(storeOpen()).toBe(false);
      expect(parentClose).toHaveBeenCalledTimes(1);
      await settle(() => list.resolve(PAGE));
    }
  );

  // In a browser the confirmation's overlay covers the store's X and backdrop;
  // these events reach them directly to pin the guard behind it.
  it.each(['X', 'backdrop'] as const)(
    "refuses the store's %s under the delete confirmation, before and during the Delete",
    async (path) => {
      await mount();
      fireEvent.click(rowButton('Config B', 'Delete'));
      dismiss(path);
      expect(storeOpen()).toBe(true);
      fireEvent.click(confirmDeleteButton());
      dismiss(path);
      expect(storeOpen()).toBe(true);
      expect(confirmOpen()).toBe(true);
      expect(parentClose).not.toHaveBeenCalled();
    }
  );

  it('shows a Delete failure in the confirmation, which stays open for a retry', async () => {
    await mount();
    startDelete('Config B');
    dismissConfirm('Escape');
    await settle(() => deletes[0].reject(new CanopyError('forbidden', 403, 'not allowed')));
    expect(confirmOpen()).toBe(true);
    expect(within(confirmModal()!).queryByText('not allowed')).not.toBeNull();
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(confirmDeleteButton());
    expect(api.deleteConfig.mock.calls.map(([slug]) => slug)).toEqual([B.slug, B.slug]);
    expect(within(confirmModal()!).queryByText('not allowed')).toBeNull();
  });

  it('can still be used after X was pressed during a Save', async () => {
    await mount();
    fireEvent.click(saveButton());
    dismiss('X');
    await settle(() => saves[0].resolve(config('slug-new', 'New', '2026-10-03T00:00:00Z')));
    await reopen();
    expect(storeOpen()).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });

  it('still toasts a Save that outlives the modal, and touches nothing else', async () => {
    const { unmount } = await mount();
    fireEvent.click(saveButton());
    unmount();
    await settle(() => saves[0].resolve(config('slug-new', 'New', '2026-10-03T00:00:00Z')));
    expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Workspace saved' }));
    expect(api.listConfigs).toHaveBeenCalledTimes(1);
  });
});

describe('ConfigStoreModal: the delete confirmation', () => {
  it('asks in a Carbon dialog over the store and explains the shared-link impact', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    await mount();
    fireEvent.click(rowButton('Config B', 'Delete'));

    expect(document.querySelectorAll('.cds--modal.is-visible')).toHaveLength(2);
    expect(screen.getByText('Save current workspace')).toBeTruthy();
    expect(
      within(confirmModal()!).getByText(
        /This will break any shared links to it\. This action cannot be undone\./
      )
    ).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(api.deleteConfig).not.toHaveBeenCalled();

    dismissConfirm('Cancel');
    expect(document.querySelectorAll('.cds--modal.is-visible')).toHaveLength(1);
    expect(screen.getByText('Config B')).toBeTruthy();
    expect(api.deleteConfig).not.toHaveBeenCalled();
  });

  it.each(CONFIRM_PATHS)(
    'closes on %s before the Delete starts, leaving the store open',
    async (path) => {
      await mount();
      fireEvent.click(rowButton('Config B', 'Delete'));
      dismissConfirm(path);
      expect(confirmOpen()).toBe(false);
      expect(storeOpen()).toBe(true);
      expect(parentClose).not.toHaveBeenCalled();
      expect(api.deleteConfig).not.toHaveBeenCalled();
    }
  );

  it('deletes only after confirming, then refreshes the list', async () => {
    await mount();
    fireEvent.click(rowButton('Config B', 'Delete'));
    expect(api.deleteConfig).not.toHaveBeenCalled();

    fireEvent.click(confirmDeleteButton());
    expect(api.deleteConfig).toHaveBeenCalledWith(B.slug);
    api.listConfigs.mockResolvedValue({ results: [A], continuationToken: null, totalCount: 1 });
    await settle(() => deletes[0].resolve());
    expect(screen.queryByText('Config B')).toBeNull();
    expect(screen.getByText('Config A')).toBeTruthy();
  });
});

describe('ConfigStoreModal: the share-link copy does not hold the Save slot', () => {
  const NEW = config('slug-new', 'New', '2026-10-03T00:00:00Z');

  it.each(PATHS)(
    'frees every action and allows %s once the Save lands, while the copy is pending',
    async (path) => {
      const copy = deferred<void>();
      const clipboard = stubClipboard(() => copy.promise);
      await mount();
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
      fireEvent.click(saveButton());
      await settle(() => saves[0].resolve(NEW));
      expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/config=slug-new$/));
      expect(saveButton().disabled).toBe(false);
      expect(allRowButtons().map((b) => b.disabled)).toEqual(Array(6).fill(false));
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
      expect(api.listConfigs).toHaveBeenCalledTimes(2);
      expect(onToast).not.toHaveBeenCalled();

      dismiss(path);
      expect(storeOpen()).toBe(false);
      expect(parentClose).toHaveBeenCalledTimes(1);

      // The toast still reports the copy after the dialog has gone.
      await settle(() => copy.resolve());
      expect(onToast).toHaveBeenCalledWith({
        kind: 'success',
        title: 'Workspace saved',
        subtitle: 'Share link copied to clipboard (slug-new)',
        timeout: undefined,
      });
    }
  );

  it('lets another operation start while the copy is pending', async () => {
    stubClipboard(() => new Promise<void>(() => {}));
    await mount();
    fireEvent.click(saveButton());
    await settle(() => saves[0].resolve(NEW));
    fireEvent.click(rowButton('Config A', 'Load'));
    expect(api.getConfig.mock.calls.map(([slug]) => slug)).toEqual([A.slug]);
  });

  // A success toast normally closes after a few seconds, too soon to copy a
  // long link by hand.
  it.each([
    [
      'is rejected',
      () => stubClipboard(() => Promise.reject(new DOMException('Denied', 'NotAllowedError'))),
    ],
    ['has no clipboard API', () => {}],
  ])('shows the link itself, until dismissed, when the copy %s', async (_case, setUp) => {
    setUp();
    await mount();
    fireEvent.click(saveButton());
    await settle(() => saves[0].resolve(NEW));
    expect(onToast).toHaveBeenCalledWith({
      kind: 'success',
      title: 'Workspace saved',
      subtitle: expect.stringMatching(/^Share link: .*\?config=slug-new$/),
      timeout: 0,
    });
  });
});
