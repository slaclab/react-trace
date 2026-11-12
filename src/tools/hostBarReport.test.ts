// The `canopy:tool-actions` report for the three tools under the host bar:
// each spec's `iconName` names the component beside it and is on the host's
// icon allowlist, and the report lists the bar entries in display order, then
// the menu entries. post-elog stays capability-gated.
import * as CarbonIcons from '@carbon/icons-react';
import { describe, expect, it, vi } from 'vitest';
import {
  ICON_NAME_PATTERN,
  toolActionsPayload,
  type ToolActionEntry,
} from '../workbench/toolActionsPublisher';
import { CORRELATION_ACTION_SPECS, correlationActions } from './correlation/actions';
import { traceCapabilities } from './trace/capabilities';
import { TRACE_ACTION_SPECS, traceActions } from './trace/actions';
import { WAVEFORM_ACTION_SPECS, waveformActions } from './waveform/actions';

/** The icon names a host tile bar draws. */
const ALLOWLIST = [
  'Renew',
  'DataTable',
  'SendAlt',
  'Download',
  'Image',
  'Grid',
  'ColumnDependency',
  'Pause',
  'Erase',
  'Camera',
  'Save',
  'Printer',
  'Upload',
];

const SPEC_TABLES = {
  trace: TRACE_ACTION_SPECS,
  correlation: CORRELATION_ACTION_SPECS,
  waveform: WAVEFORM_ACTION_SPECS,
} as const;

const icons = CarbonIcons as unknown as Record<string, unknown>;

describe('iconName beside each icon component', () => {
  for (const [tool, specs] of Object.entries(SPEC_TABLES)) {
    it.each(Object.entries(specs))(`${tool} %s: names its component, allowlisted`, (_id, spec) => {
      expect(spec.iconName).toMatch(ICON_NAME_PATTERN);
      expect(ALLOWLIST).toContain(spec.iconName);
      expect(icons[spec.iconName]).toBe(spec.icon);
    });
  }
});

const COMMON = { embedded: true, bugUrl: 'b', docsUrl: 'd' } as const;

function trace(hostBar: boolean, elog = true) {
  return traceActions({
    ...COMMON,
    hostBar,
    handlers: {
      refreshArchive: vi.fn(),
      dataInsight: vi.fn(),
      postElog: vi.fn(),
      save: vi.fn(),
      print: vi.fn(),
      import: vi.fn(),
      exportCsv: vi.fn(),
      exportPng: vi.fn(),
    },
    capabilities: traceCapabilities({ elog }),
    viewMode: { grid: true, toggle: vi.fn() },
  });
}

const streamHandlers = {
  togglePause: vi.fn(),
  exportCsv: vi.fn(),
  exportPng: vi.fn(),
  postElog: vi.fn(),
};

function correlation(hostBar: boolean, elog = true) {
  return correlationActions({
    ...COMMON,
    hostBar,
    handlers: { ...streamHandlers, clear: vi.fn() },
    paused: true,
    capabilities: { elog },
  });
}

function waveform(hostBar: boolean, elog = true) {
  return waveformActions({
    ...COMMON,
    hostBar,
    handlers: { ...streamHandlers, snapshot: vi.fn() },
    paused: false,
    capabilities: { elog },
  });
}

function placements(entries: ToolActionEntry[]) {
  return entries.map((e) => [e.id, e.placement, e.icon]);
}

describe('the report under the host bar', () => {
  it('Trace: bar in display order, then Import… · Export trace file · Print', () => {
    expect(placements(toolActionsPayload(trace(true)).actions)).toEqual([
      ['refresh-archive', 'bar', 'Renew'],
      ['data-insight', 'bar', 'DataTable'],
      ['export-csv', 'bar', 'Download'],
      ['export-png', 'bar', 'Image'],
      ['post-elog', 'bar', 'SendAlt'],
      ['view-mode', 'bar', 'Grid'],
      ['import', 'menu', 'Upload'],
      ['save', 'menu', 'Save'],
      ['print', 'menu', 'Printer'],
    ]);
    const save = toolActionsPayload(trace(true)).actions.find((e) => e.id === 'save');
    expect(save?.label).toBe('Export trace file');
    expect(save?.shortcut).toBeUndefined();
  });

  it('Trace: view-mode is a pressed toggle in the bar', () => {
    const view = toolActionsPayload(trace(true)).actions.find((e) => e.id === 'view-mode');
    expect(view).toMatchObject({ kind: 'toggle', pressed: true, placement: 'bar' });
  });

  it('Correlation: Pause · Clear · Export CSV · Export PNG · Post to E-Log, no menu', () => {
    expect(placements(toolActionsPayload(correlation(true)).actions)).toEqual([
      ['pause', 'bar', 'Pause'],
      ['clear', 'bar', 'Erase'],
      ['export-csv', 'bar', 'Download'],
      ['export-png', 'bar', 'Image'],
      ['post-elog', 'bar', 'SendAlt'],
    ]);
  });

  it('Waveform: Pause · Snapshot · Export CSV · Export PNG · Post to E-Log, no menu', () => {
    expect(placements(toolActionsPayload(waveform(true)).actions)).toEqual([
      ['pause', 'bar', 'Pause'],
      ['snapshot', 'bar', 'Camera'],
      ['export-csv', 'bar', 'Download'],
      ['export-png', 'bar', 'Image'],
      ['post-elog', 'bar', 'SendAlt'],
    ]);
  });

  it('post-elog stays hidden without a logbook', () => {
    for (const list of [trace(true, false), correlation(true, false), waveform(true, false)]) {
      const ids = toolActionsPayload(list).actions.map((e) => e.id);
      expect(ids).not.toContain('post-elog');
    }
  });
});

describe('without the host bar', () => {
  it('Trace registers no view-mode and keeps Save with its shortcut', () => {
    const list = trace(false);
    expect(list.map((a) => a.id)).not.toContain('view-mode');
    const save = list.find((a) => a.id === 'save');
    expect(save?.label).toBe('Save');
    expect(save?.shortcut).toBe('primary+S');
  });
});
