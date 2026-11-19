// The files the repository ships: `public/config.json` (copied next to the
// app, the image's neutral file) states nothing, and `config.example.json`
// documents every settable key at its built-in value, the links aside, and
// passes the validator without a warning.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEFAULTS } from './builtins';
import { resolveSiteDefaults } from './resolve';
import { SITE_KEYS, validateSiteConfig } from './validate';

const read = (rel: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BEHAVIOUR_KEYS = ['wheel', 'yAxisDrag', 'doubleClick', 'tooltip'];

function has(raw: unknown, path: string): boolean {
  let node = raw;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}

describe('public/config.json', () => {
  it('is valid and states no setting: the built-ins apply', () => {
    const config = validateSiteConfig(read('public/config.json'), 'config.json');
    expect(warn).not.toHaveBeenCalled();
    expect(config).toEqual({});
    expect(resolveSiteDefaults([config])).toEqual(BUILTIN_DEFAULTS);
  });
});

describe('config.example.json', () => {
  const example = read('config.example.json');

  it('is valid', () => {
    validateSiteConfig(example, 'config.example.json');
    expect(warn).not.toHaveBeenCalled();
  });

  it('documents every settable key (a tool’s plot behaviour through the shared plot section)', () => {
    const missing = SITE_KEYS.filter((path) => {
      if (has(example, path)) return false;
      const [, section, key] = path.split('.');
      return !(section === 'plot' && BEHAVIOUR_KEYS.includes(key) && has(example, `plot.${key}`));
    });
    expect(missing).toEqual([]);
  });

  it('shows the built-in values, its placeholder links aside', () => {
    const resolved = resolveSiteDefaults([validateSiteConfig(example, 'config.example.json')]);
    expect({ ...resolved, header: { ...resolved.header, bugReportUrl: '', docsUrl: '' } }).toEqual({
      ...BUILTIN_DEFAULTS,
      header: { ...BUILTIN_DEFAULTS.header, bugReportUrl: '', docsUrl: '' },
    });
  });

  it('names no host but the placeholder domain', () => {
    const text = readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8');
    const hosts = [...text.matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1]);
    expect(new Set(hosts)).toEqual(new Set(['example.org']));
  });
});
