// The site defaults every reader sees: one record per page load, set once by
// the loader before the first render (load.ts) and never changed after, so
// defaults never move under a user mid-session. Until it is set, and in
// tests, it is the built-ins.
//
// Read it where it is used, at call time (`siteDefaults().trace.plot`), never
// into a module-level constant: the app's modules load before the loader
// resolves.
import { BUILTIN_DEFAULTS } from './builtins';
import type { SiteDefaults } from './types';

let current: SiteDefaults = BUILTIN_DEFAULTS;

/** The site defaults of this page load. */
export function siteDefaults(): SiteDefaults {
  return current;
}

/** Sets this page load's site defaults (the loader; tests). */
export function setSiteDefaults(next: SiteDefaults): void {
  current = next;
}

/** Back to the built-ins (tests). */
export function resetSiteDefaults(): void {
  current = BUILTIN_DEFAULTS;
}
