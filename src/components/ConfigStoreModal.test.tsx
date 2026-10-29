// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { deleteConfig, listConfigs, saveConfig } from '../api/magpie';

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

function renderModal(onToast = vi.fn()) {
  return render(
    <ConfigStoreModal
      open
      plots={[plot]}
      theme="dark"
      onClose={vi.fn()}
      onLoaded={vi.fn()}
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      screen.getByText(/This will break any shared links to it\. This action cannot be undone\./)
    ).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(deleteConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteConfig).toHaveBeenCalledWith('test-config'));
    await screen.findByText('No saved configs yet.');
  });
});
