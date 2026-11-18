// @vitest-environment jsdom
//
// Reset metrics in Correlation and Waveform returns to the site's metric
// list, and is disabled while the list is the site's; built in, the
// catalog's default list.
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMetrics, type Metric } from '../statistics/model';
import { STATS_FIELD_IDS } from '../statistics/fields';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { defaultCorrelationState } from '../tools/correlation/query';
import { CORRELATION_SCHEMA } from '../tools/correlation/tool';
import { WAVEFORM_METRICS } from '../tools/waveform/metrics';
import { defaultWaveformState } from '../tools/waveform/query';
import { WAVEFORM_SCHEMA } from '../tools/waveform/tool';
import type { ToolSchema } from '../workbench/types';
import { resetSiteDefaults } from './store';
import { setSiteConfig } from './testing';

interface ResetField {
  disabled(ctx: unknown): string | false;
  run(ctx: unknown): void;
}

function resetOf(schema: ToolSchema<never, never, never>): ResetField {
  const found = schema.tool.tabs
    .flatMap((t) => t.fields)
    .find((f) => f.id === STATS_FIELD_IDS.reset);
  if (!found) throw new Error('no Reset metrics');
  return found as unknown as ResetField;
}

function ctxOf<S extends { metrics: Metric[] }>(initial: S) {
  let state = initial;
  return {
    ctx: { state, update: (fn: (s: S) => S) => void (state = fn(state)) },
    metrics: () => state.metrics,
    set(next: S) {
      state = next;
      this.ctx.state = next;
    },
  };
}

const TOOLS = [
  {
    name: 'Correlation',
    schema: CORRELATION_SCHEMA as unknown as ToolSchema<never, never, never>,
    initial: defaultCorrelationState,
    builtIn: () => defaultMetrics(CORRELATION_METRICS),
    site: { correlation: { metrics: ['mean', 'n'] } },
  },
  {
    name: 'Waveform',
    schema: WAVEFORM_SCHEMA as unknown as ToolSchema<never, never, never>,
    initial: defaultWaveformState,
    builtIn: () => defaultMetrics(WAVEFORM_METRICS),
    site: { waveform: { metrics: ['rms', 'n'] } },
  },
];

afterEach(() => resetSiteDefaults());

describe.each(TOOLS)('$name Reset metrics', ({ schema, initial, builtIn, site }) => {
  it('is disabled at the built-in list without site defaults', () => {
    const { ctx } = ctxOf(initial());
    expect(resetOf(schema).disabled(ctx)).toBe('Already the default');
  });

  it('returns to the site’s list, and is disabled there', () => {
    setSiteConfig(site);
    const at = ctxOf(initial());
    const reset = resetOf(schema);
    expect(reset.disabled(at.ctx)).toBe(false);
    reset.run(at.ctx);
    const tokens = (Object.values(site)[0] as { metrics: string[] }).metrics;
    expect(at.metrics().map((m) => m.id)).toEqual(tokens);
    at.set({ ...initial(), metrics: at.metrics() });
    expect(reset.disabled(at.ctx)).toBe('Already the default');
    expect(builtIn().map((m) => m.id)).not.toEqual(tokens);
  });
});
