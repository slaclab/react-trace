// Correlation's links stay portable under any site defaults. A view created
// at a site, encoded as its link, opens the same with no site defaults and at
// another site: the link writer always states the lookback, the period, the
// row count and the view. A query naming PVs alone (another tool's "Open in
// Correlation") is a fresh view, with the defaults of the site that opens it;
// any other key makes it a link read at the baseline.
import { afterEach, describe, expect, it } from 'vitest';
import {
  initialCorrelationState,
  siteTimer,
  withCorrelationCreation,
} from '../tools/correlation/defaults';
import { removePv, setTimer } from '../tools/correlation/edit';
import {
  defaultCorrelationState,
  normalizeCorrelationState,
  serializeCorrelationQuery,
  type CorrelationState,
} from '../tools/correlation/query';
import { BUILTIN_DEFAULTS } from './builtins';
import { resetSiteDefaults, siteDefaults } from './store';
import { setSiteConfig } from './testing';

const SITE = {
  correlation: { lookback: '30m', dt: 0.5, metrics: ['n', '-mean', 'r'], drawingTools: false },
};
const OTHER_SITE = { correlation: { lookback: '6h', dt: 2, metrics: ['mean'] } };

function atSite(config: unknown): void {
  resetSiteDefaults();
  if (config !== undefined) setSiteConfig(config);
}

const norm = (s: CorrelationState) => normalizeCorrelationState(s);

afterEach(() => resetSiteDefaults());

describe.each([
  ['the built-ins', undefined],
  ['a site’s defaults', SITE],
])('a view created with %s', (_site, config) => {
  it.each([
    ['no site defaults', undefined],
    ['another site', OTHER_SITE],
  ])('opens the same from its link with %s', (_reader, reader) => {
    atSite(config);
    const created = [
      initialCorrelationState('?x=A&y=B&y=C'),
      initialCorrelationState('?x=A&y=B&trig=T&embedded=true'),
    ];
    const links = created.map((s) => `?${serializeCorrelationQuery(s)}`);
    atSite(reader);
    links.forEach((query, i) => {
      expect(norm(initialCorrelationState(query))).toEqual(norm(created[i]));
    });
  });
});

describe('a query naming PVs alone', () => {
  it('opens as a fresh view, with the site’s defaults; any other key reads at the baseline', () => {
    atSite(SITE);
    const fresh = initialCorrelationState('?x=A&y=B&theme=dark');
    expect(fresh).toMatchObject({
      x: 'A',
      ys: ['B'],
      lookback: '30m',
      trigger: { mode: 'timer', dtS: 0.5 },
      drawingTools: false,
    });
    expect(fresh.metrics.map((m) => [m.id, m.on])).toEqual([
      ['n', true],
      ['mean', false],
      ['r', true],
    ]);
    const link = initialCorrelationState('?x=A&y=B&n=500');
    const baseline = defaultCorrelationState();
    expect(link).toMatchObject({
      lookback: baseline.lookback,
      trigger: baseline.trigger,
      metrics: baseline.metrics,
    });
    expect(link.drawingTools).toBeUndefined();
  });

  it('keeps a trigger PV it names', () => {
    atSite(SITE);
    expect(initialCorrelationState('?x=A&y=B&trig=T').trigger).toEqual({ mode: 'pv', pv: 'T' });
  });

  it('opens at the baseline with the built-ins', () => {
    atSite(undefined);
    expect(norm(initialCorrelationState('?x=A&y=B'))).toEqual(
      norm({ ...defaultCorrelationState(), x: 'A', ys: ['B'] })
    );
    expect(
      withCorrelationCreation(defaultCorrelationState(), BUILTIN_DEFAULTS.correlation)
    ).toEqual(defaultCorrelationState());
  });
});

describe('the Timer trigger', () => {
  it('starts at the site’s period when a trigger PV is dropped', () => {
    atSite(SITE);
    expect(siteTimer()).toEqual({ mode: 'timer', dtS: 0.5 });
    const pv = initialCorrelationState('?x=A&y=B&trig=T');
    expect(setTimer(pv).trigger).toEqual({ mode: 'timer', dtS: 0.5 });
    expect(removePv(pv, 'trig', 'T').trigger).toEqual({ mode: 'timer', dtS: 0.5 });
    expect(siteDefaults().correlation.dt).toBe(0.5);
  });
});
