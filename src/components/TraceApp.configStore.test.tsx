// @vitest-environment jsdom
//
// The config store (#79, #177) on the workbench: the actions bar's Config
// store opens main's dialog, whose Load goes through the same applyWorkspace
// as file import; and a `?config=<slug>` link loads that stored workspace at
// startup. The link wins over the plot keys (one console.info names them),
// a failure reads through the shared error reader, and only standalone Trace
// strips the slug from its URL afterwards: embedded, the host owns the URL.
import { StrictMode, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  actionButton,
  axis,
  currentPlots,
  flushMicrotasks,
  plot,
  pvTrace,
  resetHarness,
} from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { deserializeConfigData, serializeConfigData } from '../io/serialize';
import type { ConfigDTO } from '../api/types';
import type { ConfigStoreModal } from './ConfigStoreModal';
import { TraceApp } from './TraceApp';

interface ConfigCall {
  slug: string;
  signal: AbortSignal | undefined;
  resolve: (dto: ConfigDTO) => void;
  reject: (err: unknown) => void;
}

const hoisted = vi.hoisted(() => ({
  configCalls: [] as ConfigCall[],
  store: { props: null as ComponentProps<typeof ConfigStoreModal> | null },
}));
const { configCalls, store } = hoisted;

vi.mock('../api/magpie', () => ({
  getConfig: (slug: string, signal?: AbortSignal) =>
    new Promise((resolve, reject) => hoisted.configCalls.push({ slug, signal, resolve, reject })),
}));
vi.mock('./ConfigStoreModal', () => ({
  ConfigStoreModal(props: ComponentProps<typeof ConfigStoreModal>) {
    hoisted.store.props = props;
    return null;
  },
}));
vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  fetchData: () => new Promise(() => {}),
  fetchMetadata: () => new Promise(() => {}),
  listArchivers: () => new Promise(() => {}),
  searchPVs: () => new Promise(() => {}),
}));
vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock('../workbench/WorkbenchLayout', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.WorkbenchLayout(await importOriginal())
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

// The stored workspace: one plot titled "Stored" with one curve.
const STORED = serializeConfigData({
  theme: 'dark',
  plots: [
    plot('plot-s', [axis('axis-s', 'Y')], [pvTrace('trace-s', 'SIM:STORED')], { title: 'Stored' }),
  ],
});

function dto(patch: Partial<ConfigDTO> = {}): ConfigDTO {
  return {
    id: 'id-1',
    app: 'trace',
    slug: 'abc123',
    name: 'Beam overview',
    description: null,
    data: STORED,
    createdBy: null,
    createdDate: '2026-11-01T00:00:00Z',
    lastModifiedDate: '2026-11-01T00:00:00Z',
    ...patch,
  };
}

function openAt(search: string) {
  window.history.replaceState(null, '', `/${search}`);
}

function mount({ strict = false } = {}) {
  render(
    strict ? (
      <StrictMode>
        <TraceApp />
      </StrictMode>
    ) : (
      <TraceApp />
    ),
    { wrapper: WithCanopy }
  );
}

async function settle(fn: () => void) {
  await act(async () => {
    fn();
    await flushMicrotasks();
  });
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetHarness();
  configCalls.length = 0;
  store.props = null;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  info.mockRestore();
  openAt('');
});

describe('the Config store action', () => {
  it("opens main's dialog with the workspace, and its Load applies the stored one", async () => {
    mount();
    expect(store.props).toBeNull();
    fireEvent.click(actionButton('Config store'));
    expect(store.props?.open).toBe(true);
    expect(store.props?.plots).toBe(currentPlots());
    expect(store.props?.theme).toMatch(/^(light|dark)$/);

    // The dialog's Load: deserialize, then hand it over (it closes itself after).
    act(() => store.props!.onLoaded(deserializeConfigData(STORED)));
    expect(currentPlots().map((p) => p.title)).toEqual(['Stored']);
    expect(currentPlots()[0].traces.map((t) => t.pvName)).toEqual(['SIM:STORED']);

    // A workspace with no plots is refused before anything changes; the dialog shows it.
    expect(() => store.props!.onLoaded({ ...deserializeConfigData(STORED), plots: [] })).toThrow(
      'Workspace contains no plots'
    );
    expect(currentPlots().map((p) => p.title)).toEqual(['Stored']);

    act(() => store.props!.onToast({ kind: 'success', title: 'Workspace saved' }));
    expect(screen.getByText('Workspace saved')).toBeTruthy();

    act(() => store.props!.onClose());
    store.props = null;
    fireEvent.click(actionButton('Config store'));
    expect(store.props).not.toBeNull();
  });
});

describe('a ?config= link', () => {
  it('loads the stored workspace at startup, says so, and strips the slug standalone', async () => {
    openAt('?config=abc123&theme=dark');
    mount();
    expect(configCalls.map((c) => c.slug)).toEqual(['abc123']);
    expect(info).not.toHaveBeenCalled();

    await settle(() => configCalls[0].resolve(dto()));
    expect(currentPlots().map((p) => p.title)).toEqual(['Stored']);
    expect(screen.getByText('Workspace loaded')).toBeTruthy();
    expect(screen.getByText('Loaded "Beam overview"')).toBeTruthy();
    expect(window.location.search).toBe('?theme=dark');
  });

  it('wins over the plot keys, which are ignored with one console.info', async () => {
    openAt('?config=abc123&pv=SIM:A&range=-15m');
    mount({ strict: true });
    // StrictMode mounts twice: the first request is aborted, the info is said once.
    expect(currentPlots()[0].traces).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('abc123');
    expect(String(info.mock.calls[0][0])).toContain('pv, range');

    const live = configCalls.filter((c) => !c.signal?.aborted);
    expect(live).toHaveLength(1);
    await settle(() => live[0].resolve(dto()));
    expect(currentPlots()[0].traces.map((t) => t.pvName)).toEqual(['SIM:STORED']);
    const left = new URLSearchParams(window.location.search);
    expect(left.has('config')).toBe(false);
    expect(left.getAll('pv')).toEqual(['SIM:A']);
    expect(left.get('range')).toBe('-15m');
  });

  it('reports a failed load through the shared error reader and leaves the opening plot', async () => {
    openAt('?config=gone');
    mount();
    await settle(() =>
      configCalls[0].reject(
        Object.assign(new Error('HTTP 404'), { code: 'config_not_found', detail: 'No config gone' })
      )
    );
    expect(screen.getByText('Could not load shared workspace')).toBeTruthy();
    expect(screen.getByText('No config gone')).toBeTruthy();
    expect(currentPlots()).toHaveLength(1);
    expect(currentPlots()[0].traces).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('names an untitled config by its slug and lists the warnings of the load', async () => {
    openAt('?config=abc123');
    mount();
    // A legacy .trc document whose time range is not understood loads with a warning.
    const legacy = { curves: [{ channel: 'SIM:W' }], 'y-axes': [], time_axis: { start: 'soon' } };
    const { warnings } = deserializeConfigData(legacy);
    expect(warnings.length).toBeGreaterThan(0);
    await settle(() => configCalls[0].resolve(dto({ name: null, data: legacy })));
    expect(currentPlots()[0].traces.map((t) => t.pvName)).toEqual(['SIM:W']);
    expect(screen.getByText('Workspace loaded')).toBeTruthy();
    expect(document.body.textContent).toContain('Loaded config abc123');
    expect(document.body.textContent).toContain(warnings[0]);
  });

  it('embedded: loads the workspace but leaves the URL to the host', async () => {
    openAt('?embedded=true&config=abc123');
    mount();
    await settle(() => configCalls[0].resolve(dto()));
    expect(currentPlots().map((p) => p.title)).toEqual(['Stored']);
    // Before the state report's debounce (useTraceStateOut): no rewrite of our own.
    expect(window.location.search).toBe('?embedded=true&config=abc123');
  });

  it('does nothing without a slug', () => {
    openAt('?config=&pv=SIM:A');
    mount();
    expect(configCalls).toEqual([]);
    expect(info).not.toHaveBeenCalled();
    expect(currentPlots()[0].traces.map((t) => t.pvName)).toEqual(['SIM:A']);
  });

  it('aborts the request when Trace unmounts, and then leaves the URL alone', async () => {
    openAt('?config=abc123');
    mount();
    const call = configCalls[0];
    cleanup();
    expect(call.signal?.aborted).toBe(true);
    await settle(() => call.resolve(dto()));
    expect(window.location.search).toBe('?config=abc123');
  });
});
