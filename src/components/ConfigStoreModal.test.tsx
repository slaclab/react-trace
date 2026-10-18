// @vitest-environment jsdom
//
// Pins ConfigStoreModal's async lifecycle (slaclab/react-trace#92). Save and
// every row's Load/Rename/Delete share one busy slot, so only one runs at a
// time. Save, Rename and Delete block all three of Carbon's dismissal paths (X,
// Escape, backdrop) until they settle.
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
// The workspace codec isn't under test: Save sends {}, Load hands `data` through.
vi.mock('../io/serialize', () => ({
  serializeConfigData: () => ({}),
  deserializeConfigData: (data: unknown) => data,
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

// Stands in for TraceApp: owns `open`, always mounts the modal, and has a
// toolbar button that can only set `open` to true.
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>toolbar-open</button>
      <button onClick={() => setOpen(false)}>parent-close</button>
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

function modal(): HTMLElement {
  return document.querySelector('.cds--modal') as HTMLElement;
}

function isVisible(): boolean {
  return modal().classList.contains('is-visible');
}

type RowAction = 'Load' | 'Rename' | 'Delete';
const ROW_ACTIONS: RowAction[] = ['Load', 'Rename', 'Delete'];

// `hidden: true` throughout: after a close, aria-hidden follows the `open` prop.
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

function errorBanner(): Element | null {
  return document.querySelector('.cds--inline-notification');
}

const PATHS = ['X', 'Escape', 'backdrop'] as const;
type DismissPath = (typeof PATHS)[number];

function dismiss(path: DismissPath) {
  switch (path) {
    case 'X':
      fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
      break;
    case 'Escape':
      fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
      break;
    case 'backdrop':
      fireEvent.mouseDown(modal());
      fireEvent.click(modal());
      break;
  }
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
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  // No vitest globals, so RTL can't register its own cleanup.
  cleanup();
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
    expect(onLoaded).toHaveBeenCalledWith(A.data);
    expect(onToast).toHaveBeenCalledTimes(1);
  });

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
      expect(window.confirm).not.toHaveBeenCalled();
      expect(api.updateConfig).not.toHaveBeenCalled();
      expect(api.deleteConfig).not.toHaveBeenCalled();
    }
  );

  it('does not start a Load while a Delete is in flight', async () => {
    await mount();
    fireEvent.click(rowButton('Config B', 'Delete'));
    fireEvent.click(rowButton('Config A', 'Load'));
    expect(api.getConfig).not.toHaveBeenCalled();
  });

  it("keeps A's Load disabled when a Rename clicked during it would have finished", async () => {
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
    fireEvent.click(rowButton('Config A', action));
    expect(screen.queryByText(status)).not.toBeNull();
  });

  it('shows a Load failure and re-enables the row (control: passes before the fix too)', async () => {
    await mount();
    fireEvent.click(rowButton('Config A', 'Load'));
    await settle(() => loads[0].reject(new CanopyError('config_not_found', 404, 'not found')));
    expect(screen.queryByText('not found')).not.toBeNull();
    expect(rowButton('Config A', 'Load').disabled).toBe(false);
    expect(isVisible()).toBe(true);
    expect(onLoaded).not.toHaveBeenCalled();
  });
});

describe('ConfigStoreModal: Save, Rename and Delete block dismissal', () => {
  it.each(PATHS)(
    'blocks %s during a Save, then closes on it once the Save settles',
    async (path) => {
      await mount();
      fireEvent.click(saveButton());
      dismiss(path);
      expect(isVisible()).toBe(true);
      expect(parentClose).not.toHaveBeenCalled();

      await settle(() => saves[0].resolve(config('slug-new', 'New', '2026-10-03T00:00:00Z')));
      expect(saveButton().disabled).toBe(false);
      dismiss(path);
      expect(isVisible()).toBe(false);
      expect(parentClose).toHaveBeenCalledTimes(1);
      await reopen();
      expect(isVisible()).toBe(true);
    }
  );

  it('can still be opened from the toolbar after X was pressed during a Save', async () => {
    await mount();
    fireEvent.click(saveButton());
    dismiss('X');
    await settle(() => saves[0].resolve(config('slug-new', 'New', '2026-10-03T00:00:00Z')));
    await reopen();
    expect(isVisible()).toBe(true);
  });

  it.each(PATHS.flatMap((path) => (['Rename', 'Delete'] as const).map((a) => [a, path] as const)))(
    'blocks dismissal during a %s (%s), then refreshes the list and closes',
    async (action, path) => {
      await mount();
      fireEvent.click(rowButton('Config B', action));
      dismiss(path);
      expect(isVisible()).toBe(true);
      expect(parentClose).not.toHaveBeenCalled();

      const listCalls = api.listConfigs.mock.calls.length;
      await settle(() => (action === 'Rename' ? renames[0].resolve(B) : deletes[0].resolve()));
      expect(api.listConfigs).toHaveBeenCalledTimes(listCalls + 1);
      expect(rowButton('Config A', 'Load').disabled).toBe(false);
      dismiss(path);
      expect(isVisible()).toBe(false);
      expect(parentClose).toHaveBeenCalledTimes(1);
    }
  );

  it('shows a Delete failure in the dialog it kept open', async () => {
    await mount();
    fireEvent.click(rowButton('Config B', 'Delete'));
    dismiss('Escape');
    await settle(() => deletes[0].reject(new CanopyError('forbidden', 403, 'not allowed')));
    expect(isVisible()).toBe(true);
    expect(screen.queryByText('not allowed')).not.toBeNull();
    expect(rowButton('Config B', 'Delete').disabled).toBe(false);
  });

  it('keeps Save disabled across a parent-driven close and reopen until the Save settles', async () => {
    await mount();
    fireEvent.click(saveButton());
    fireEvent.click(screen.getByText('parent-close'));
    await reopen();
    expect(saveButton().disabled).toBe(true);
    await settle(() => saves[0].resolve(config('slug-new', 'New', '2026-10-03T00:00:00Z')));
    expect(saveButton().disabled).toBe(false);
    expect(errorBanner()).toBeNull();
  });
});
