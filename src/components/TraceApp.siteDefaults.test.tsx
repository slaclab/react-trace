// @vitest-environment jsdom
//
// The whole TraceApp opens with the site defaults: the fresh tab's plot and
// an added plot both take them (here the crosshair, on at this site).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';
import { resetSiteDefaults } from '../site/store';
import { setSiteConfig } from '../site/testing';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

function openPlotSection(id: string) {
  const head = document.querySelector<HTMLElement>(
    `.wb-plot-section[data-section="${id}"] .wb-plot-section__head`
  );
  if (!head) throw new Error(`no plot section ${id}`);
  fireEvent.click(head);
}

const crosshair = () => document.getElementById('show-crosshair')?.getAttribute('aria-checked');

describe('TraceApp with site defaults', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: false,
      media,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    );
    setSiteConfig({ trace: { plot: { showCrosshair: true } } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetSiteDefaults();
  });

  it('opens the fresh tab’s plot and an added plot with them', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    openPlotSection('display');
    expect(crosshair()).toBe('true');
    fireEvent.click(screen.getByTitle('Add plot'));
    // The Display section stays open for the new plot.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Plot 2');
    expect(crosshair()).toBe('true');
  });
});
