// Test helper: set the site defaults that `raw` sources (in order, as a
// `config.json` would hold them) resolve to. Pair with `resetSiteDefaults`.
import { resolveSiteDefaults } from './resolve';
import { setSiteDefaults } from './store';
import type { SiteDefaults } from './types';
import { validateSiteConfig } from './validate';

export function setSiteConfig(...raw: unknown[]): SiteDefaults {
  const defaults = resolveSiteDefaults(raw.map((r, i) => validateSiteConfig(r, `test ${i}`)));
  setSiteDefaults(defaults);
  return defaults;
}
