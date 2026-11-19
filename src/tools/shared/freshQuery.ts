// Whether a context tool's page query is a fresh creation (src/site): it
// carries nothing but its PVs (and, for Correlation, a lookback), so the tool
// opens a new view with the site's defaults. Any other key (a setting, even
// at its baseline value) makes it a link to read at the wire baseline. Page
// keys are the page's, not the view's.
import { PAGE_KEYS } from '../../embed/pageKeys';
import { BENCH_KEY } from './renderMark';

const PAGE_ONLY_KEYS: ReadonlySet<string> = new Set([...PAGE_KEYS, BENCH_KEY]);

/** Whether `search` (with or without "?") carries nothing but `keys` and page keys. */
export function carriesOnly(search: string, keys: readonly string[]): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const key of params.keys()) {
    if (!PAGE_ONLY_KEYS.has(key) && !keys.includes(key)) return false;
  }
  return true;
}
