// @vitest-environment node
// The host contract re-points Carbon's zone tokens through canopy-shell's wiring.json, which is
// generated from the shell's Carbon. This pins it against Trace's own Carbon, so a Carbon bump
// here that adds or drops a token fails until the contract is regenerated.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Wiring = Record<'zone' | 'type' | 'layout', Record<string, unknown>>;

const require = createRequire(import.meta.url);
// Read from disk: vitest blanks `.css` imports, `?raw` included.
const css = readFileSync(require.resolve('@carbon/styles/css/styles.css'), 'utf8');
const wiring = JSON.parse(
  readFileSync(require.resolve('@slaclab/canopy-shell/wiring.json'), 'utf8')
) as Wiring;

// The regexes of canopy-shell's scripts/gen-tokens.mjs, which the package does not export.
const ZONES = ['white', 'g10', 'g90', 'g100'];
const MIN_ZONE_DECLARATIONS = 200;
const DECLARATION = /(--cds-[a-z0-9-]+):\s*([^;]+);/g;
const TYPE_READ = /var\(\s*(--cds-[a-z0-9-]+-font-(?:size|family))\b/g;

/** The names declared by the `.cds--<zone> { … }` theme blocks (small same-named rules skipped). */
function zoneBlocks(zone: string): Set<string>[] {
  const block = new RegExp(`(?:^|\\})\\s*\\.cds--${zone}\\s*\\{([^{}]*)\\}`, 'gm');
  return [...css.matchAll(block)]
    .map((match) => new Set([...match[1]!.matchAll(DECLARATION)].map((found) => found[1]!)))
    .filter((names) => names.size >= MIN_ZONE_DECLARATIONS);
}

describe('host contract coverage of Trace’s Carbon', () => {
  it('wires exactly the tokens the four zone blocks declare', () => {
    const blocks = ZONES.map(zoneBlocks);
    expect(blocks.map((found) => found.length)).toEqual([1, 1, 1, 1]);
    const declared = new Set(blocks.flatMap(([names]) => [...names!]));
    expect([...declared].sort()).toEqual(Object.keys(wiring.zone).sort());
  });

  it('wires every type token the stylesheet reads', () => {
    const reads = [...new Set([...css.matchAll(TYPE_READ)].map((match) => match[1]!))];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((name) => !(name in wiring.type))).toEqual([]);
  });
});
