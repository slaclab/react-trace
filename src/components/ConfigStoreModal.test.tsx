// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigStoreModal } from './ConfigStoreModal';
import type { ConfigDTO } from '../api/types';
import type { Plot } from '../types';

vi.mock('../api/magpie', () => ({
  saveConfig: vi.fn(),
  getConfig: vi.fn(),
  listConfigs: vi.fn(),
  updateConfig: vi.fn(),
  deleteConfig: vi.fn(),
}));

import { deleteConfig, getConfig, listConfigs, saveConfig } from '../api/magpie';

const plot: Plot = {
  id: 'plot-1',
  title: 'Plot',
  traces: [],
  axes: [],
  backgroundColor: '#161616',
  showLegend: true,
  showXGridlines: true,
  showYGridlines: true,
  showCrosshair: true,
  gridStyle: 'solid',
  gridOpacity: 1,
  tickFontSize: 11,
  xAxis: { timeRange: '-1h' },
};

const savedConfig: ConfigDTO = {
  id: 'config-1',
  app: 'trace',
  slug: 'share-slug',
  name: null,
  description: null,
  data: {},
  createdBy: null,
  createdDate: '2026-10-01T00:00:00Z',
  lastModifiedDate: '2026-10-01T00:00:00Z',
};

const listedConfig: ConfigDTO = {
  ...savedConfig,
  slug: 'test-config',
  name: 'Test config',
};

const secondListedConfig: ConfigDTO = {
  ...listedConfig,
  slug: 'second-config',
  name: 'Second config',
};

function renderModal(onToast = vi.fn(), onLoaded = vi.fn()) {
  return render(
    <ConfigStoreModal
      open
      plots={[plot]}
      theme="dark"
      onClose={vi.fn()}
      onLoaded={onLoaded}
      onToast={onToast}
    />
  );
}

describe('ConfigStoreModal', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    // jsdom has no scrollIntoView. Carbon's modal calls it when focus moves to
    // an element inside a scrolling ModalBody.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.mocked(listConfigs).mockResolvedValue({
      results: [],
      continuationToken: null,
      totalCount: 0,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('cannot be dismissed while a save is in progress', async () => {
    vi.mocked(saveConfig).mockImplementation(() => new Promise(() => {}));
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /Save & copy share link/ }));
    await screen.findByRole('button', { name: 'Saving…' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(document.querySelector('.cds--modal.is-visible')).not.toBeNull();
  });

  it('keeps the fallback share link available until the toast is dismissed', async () => {
    vi.mocked(saveConfig).mockResolvedValue(savedConfig);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const onToast = vi.fn();
    renderModal(onToast);

    fireEvent.click(screen.getByRole('button', { name: /Save & copy share link/ }));

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Workspace saved',
          subtitle: expect.stringContaining('share-slug'),
          timeout: 0,
        })
      );
    });
  });

  it('uses a Carbon dialog to confirm deletion and explain the shared-link impact', async () => {
    vi.mocked(listConfigs).mockResolvedValue({
      results: [listedConfig],
      continuationToken: null,
      totalCount: 1,
    });
    const nativeConfirm = vi.spyOn(window, 'confirm');
    renderModal();

    await screen.findByText('test-config');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    expect(document.querySelectorAll('.cds--modal.is-visible')).toHaveLength(2);
    expect(screen.getByText('Save current workspace')).toBeTruthy();
    expect(
      screen.getByText(/This will break any shared links to it\. This action cannot be undone\./)
    ).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(deleteConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelectorAll('.cds--modal.is-visible')).toHaveLength(1);
    await screen.findByText('test-config');
  });

  it('deletes the config only after confirming in the Carbon dialog', async () => {
    vi.mocked(listConfigs)
      .mockResolvedValueOnce({
        results: [listedConfig],
        continuationToken: null,
        totalCount: 1,
      })
      .mockResolvedValue({
        results: [],
        continuationToken: null,
        totalCount: 0,
      });
    vi.mocked(deleteConfig).mockResolvedValue();
    renderModal();

    await screen.findByText('test-config');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    fireEvent.click(document.querySelector('.cds--modal--danger .cds--btn--danger')!);

    await waitFor(() => expect(deleteConfig).toHaveBeenCalledWith('test-config'));
    await screen.findByText('No saved configs yet.');
    // The row's button went with the row, so focus falls back to the store body.
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Config store contents' })
    );
  });

  it('falls back to the store body when the delete trigger is disabled on close', async () => {
    vi.mocked(listConfigs).mockResolvedValue({
      results: [listedConfig],
      continuationToken: null,
      totalCount: 1,
    });
    renderModal();
    await screen.findByText('test-config');

    const trigger = screen.getAllByRole('button', { name: 'Delete' })[0];
    fireEvent.click(trigger);
    // Stands in for a row still mid-delete (busySlug) when the dialog closes.
    (trigger as HTMLButtonElement).disabled = true;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(document.querySelectorAll('.cds--modal.is-visible')).toHaveLength(1)
    );
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Config store contents' })
    );
  });

  it('moves focus into the delete confirmation and back to its trigger on Escape', async () => {
    // Carbon's focus wrap only targets elements with an offsetParent, which
    // jsdom never sets (no layout). Without one the store's wrap can't move
    // focus at all and this test couldn't see it pull focus back.
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement;
      },
    });
    const focusedOutside: Element[] = [];
    const recordFocus = (e: FocusEvent) => {
      if (!(e.target as Element).closest('.cds--modal--danger')) {
        focusedOutside.push(e.target as Element);
      }
    };
    try {
      vi.mocked(listConfigs).mockResolvedValue({
        results: [listedConfig],
        continuationToken: null,
        totalCount: 1,
      });
      renderModal();
      await screen.findByText('test-config');

      // A keyboard user tabs to the row's Delete button and presses Enter.
      const trigger = screen.getAllByRole('button', { name: 'Delete' })[0];
      trigger.focus();
      document.addEventListener('focusin', recordFocus);
      fireEvent.click(trigger);

      const confirmation = document.querySelector<HTMLElement>('.cds--modal--danger')!;
      const cancel = within(confirmation).getByRole('button', { name: 'Cancel' });
      await waitFor(() => expect(document.activeElement).toBe(cancel));
      // jsdom lets the outer focus() win, so also check the store never took
      // focus on the way (in a browser its pull-back wins and focus stays there).
      expect(focusedOutside).toEqual([]);
      document.removeEventListener('focusin', recordFocus);

      // One Escape closes the confirmation and focus goes back to the trigger.
      fireEvent.keyDown(cancel, { key: 'Escape' });
      await waitFor(() =>
        expect(document.querySelectorAll('.cds--modal.is-visible')).toHaveLength(1)
      );
      expect(document.activeElement).toBe(trigger);
    } finally {
      document.removeEventListener('focusin', recordFocus);
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
    }
  });

  it('aborts superseded loads and only applies the latest response', async () => {
    vi.mocked(listConfigs).mockResolvedValue({
      results: [listedConfig, secondListedConfig],
      continuationToken: null,
      totalCount: 2,
    });
    const requests: {
      signal: AbortSignal;
      resolve: (value: ConfigDTO) => void;
    }[] = [];
    vi.mocked(getConfig).mockImplementation(
      (_slug, signal) =>
        new Promise((resolve) => {
          requests.push({ signal: signal!, resolve });
        })
    );
    const onLoaded = vi.fn();
    renderModal(undefined, onLoaded);
    await screen.findByText('test-config');

    fireEvent.click(screen.getAllByRole('button', { name: 'Load' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Load' })[1]);

    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);

    const data = { schemaVersion: 1, plots: [plot] };
    requests[0].resolve({ ...listedConfig, data });
    requests[1].resolve({ ...secondListedConfig, data });

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(onLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ plots: [expect.objectContaining({ id: 'plot-1' })] })
    );
  });

  it('aborts a pending load when the modal unmounts', async () => {
    vi.mocked(listConfigs).mockResolvedValue({
      results: [listedConfig],
      continuationToken: null,
      totalCount: 1,
    });
    vi.mocked(getConfig).mockImplementation(
      (_slug, signal) =>
        new Promise(() => {
          expect(signal).toBeDefined();
        })
    );
    const onLoaded = vi.fn();
    const view = renderModal(undefined, onLoaded);
    await screen.findByText('test-config');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    const signal = vi.mocked(getConfig).mock.calls.at(-1)?.[1];
    view.unmount();

    expect(signal?.aborted).toBe(true);
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
