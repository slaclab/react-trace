// @vitest-environment jsdom
//
// Waveform's links stay portable under any site defaults. A view created at a
// site, encoded as its link, opens the same with no site defaults; at another
// site too, when it carries any setting. A query naming PVs alone is a fresh
// view, with the defaults of the site that opens it, so a view back at the
// baseline while its site's new views are not writes `rail=1` and still
// reopens at the baseline. The Rolling mean starts at the site's window.
import { afterEach, describe, expect, it } from 'vitest';
import { setRolling } from '../tools/waveform/edit';
import {
  initialWaveformState,
  siteRollS,
  waveformLinkQuery,
  withWaveformCreation,
} from '../tools/waveform/defaults';
import {
  defaultWaveformState,
  normalizeWaveformState,
  serializeWaveformQuery,
  type WaveformState,
} from '../tools/waveform/query';
import { WAVEFORM_SCHEMA } from '../tools/waveform/tool';
import { BUILTIN_DEFAULTS } from './builtins';
import { resetSiteDefaults } from './store';
import { setSiteConfig } from './testing';

const SITE = { waveform: { metrics: ['n', 'mean'], drawingTools: false, rollS: 120 } };
const OTHER_SITE = { waveform: { metrics: ['rms'], rollS: 30 } };

function atSite(config: unknown): void {
  resetSiteDefaults();
  if (config !== undefined) setSiteConfig(config);
}

const norm = (s: WaveformState) => normalizeWaveformState(s);
const link = (s: WaveformState) => `?${waveformLinkQuery(serializeWaveformQuery(s))}`;

afterEach(() => resetSiteDefaults());

describe('a view created with a site’s defaults', () => {
  it.each([
    ['no site defaults', undefined],
    ['another site', OTHER_SITE],
  ])('opens the same from its link with %s', (_reader, reader) => {
    atSite(SITE);
    const fresh = initialWaveformState('?pv=A&pv=B');
    const created = [fresh, setRolling(fresh, siteRollS())];
    const links = created.map(link);
    expect(created[1].reference).toEqual({ kind: 'rolling', seconds: 120 });
    atSite(reader);
    links.forEach((query, i) => {
      expect(norm(initialWaveformState(query))).toEqual(norm(created[i]));
    });
  });

  it('reopens at the baseline after its settings went back to it', () => {
    atSite(SITE);
    const fresh = initialWaveformState('?pv=A');
    const back = { ...fresh, metrics: defaultWaveformState().metrics, drawingTools: undefined };
    expect(link(back)).toBe('?pv=A&rail=1');
    expect(norm(initialWaveformState(link(back)))).toEqual(norm(back));
  });
});

describe('a view created with the built-ins', () => {
  it('writes its PVs alone and opens the same with no site defaults', () => {
    atSite(undefined);
    const fresh = initialWaveformState('?pv=A');
    expect(link(fresh)).toBe('?pv=A');
    expect(norm(initialWaveformState(link(fresh)))).toEqual(norm(fresh));
    expect(withWaveformCreation(defaultWaveformState(), BUILTIN_DEFAULTS.waveform)).toEqual(
      defaultWaveformState()
    );
  });
});

describe('a query naming PVs alone', () => {
  it('opens as a fresh view, with the site’s defaults; any other key reads at the baseline', () => {
    atSite(SITE);
    const fresh = initialWaveformState('?pv=A&ref=R&xs=X&embedded=true');
    expect(fresh).toMatchObject({ pvs: ['A'], xs: 'X', drawingTools: false });
    expect(fresh.metrics.map((m) => m.id)).toEqual(['n', 'mean']);
    const linked = initialWaveformState('?pv=A&hz=5');
    expect(linked.drawingTools).toBeUndefined();
    expect(linked.metrics).toEqual(defaultWaveformState().metrics);
  });
});

describe('the Rolling mean', () => {
  it('turns on at the site’s window', () => {
    atSite(SITE);
    const sections = Object.values(WAVEFORM_SCHEMA.sections).flatMap((s) =>
      s.tabs.flatMap((t) => t.fields)
    );
    const rolling = sections.find((f) => f.id === 'rolling');
    if (!rolling || rolling.kind !== 'toggle') throw new Error('no Rolling mean toggle');
    let next: WaveformState | undefined;
    const state = initialWaveformState('?pv=A');
    rolling.set(
      { state, update: (fn: (s: WaveformState) => WaveformState) => (next = fn(state)) } as never,
      true
    );
    expect(next?.reference).toEqual({ kind: 'rolling', seconds: 120 });
  });
});
