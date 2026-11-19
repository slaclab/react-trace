// The shared host-probe data, read from the one place it lives: the shell
// package's `fixtures/host/`. Probe rows, the synthetic host values and every
// setup body are owned there and used unchanged by the viewer's and Trace's
// specs; this module only loads them and re-exports the shell's runner, which
// holds all assertion logic. Nothing here asserts anything.
//
// The JSON is read with `require.resolve` + `readFileSync` (resolved through
// the package's `./fixtures/*` export), not imported. Trace is an ES module
// package, so the `require` is made from this module's URL.
//
// The runner is loaded once through a dynamic `import()` and its
// asynchronous entry points are re-exported as same-signature functions; the
// rest (`pageFor`, `ProbeFailure`, ...) come from `await loadRunner()`.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Type-only: erased at compile time, so it loads nothing.
import type {
  HostFixture,
  HostProbes,
  ProbeApp,
  ProbeRow,
} from '@slaclab/canopy-shell/fixtures/host/runner.mjs';

export type * from '@slaclab/canopy-shell/fixtures/host/runner.mjs';

type Runner = typeof import('@slaclab/canopy-shell/fixtures/host/runner.mjs');
type Setups = typeof import('@slaclab/canopy-shell/fixtures/host/setups.mjs');

let runner: Promise<Runner> | undefined;
let setups: Promise<Setups> | undefined;

/** The shell's `runner.mjs`, loaded once as an ES module. */
export function loadRunner(): Promise<Runner> {
  return (runner ??= import('@slaclab/canopy-shell/fixtures/host/runner.mjs'));
}

/** The shell's `setups.mjs` (setup bodies, `HOLD_PV`, `WRITE_PROBE_PAGE`), loaded once. */
export function loadSetups(): Promise<Setups> {
  return (setups ??= import('@slaclab/canopy-shell/fixtures/host/setups.mjs'));
}

export const checkRow: Runner['checkRow'] = async (...args) =>
  (await loadRunner()).checkRow(...args);
export const runSetups: Runner['runSetups'] = async (...args) =>
  (await loadRunner()).runSetups(...args);
export const readHostValues: Runner['readHostValues'] = async (...args) =>
  (await loadRunner()).readHostValues(...args);

/** Text of one file under the shell's `fixtures/host/`. */
export function readShellFixture(file: string): string {
  return readFileSync(require.resolve(`@slaclab/canopy-shell/fixtures/host/${file}`), 'utf8');
}

/** Every probe row with the default page of each app. */
export const hostProbes = JSON.parse(readShellFixture('hostProbes.json')) as HostProbes;

/** The synthetic host's themes and the contract values it declares in each. */
export const hostFixture = JSON.parse(readShellFixture('host.json')) as HostFixture;

/** The probe rows of the given apps, in table order. */
export function rowsFor(...apps: ProbeApp[]): ProbeRow[] {
  return hostProbes.rows.filter((row) => apps.includes(row.app));
}

/** The rows Trace's specs run: the Trace page, the correlation page and the waveform page. */
export const traceRows = rowsFor('trace', 'correlation', 'waveform');
