import { useEffect, useState } from 'react';
import { searchPVs } from '@slaclab/canopy-client';
import { useCanopyConnection } from '@slaclab/canopy-react';
import { errorInfo } from '../api/errorInfo';

export type PVSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PVSearchResult {
  status: PVSearchStatus;
  pvs: string[];
  /** The archiver had more matches than the requested limit. */
  truncated: boolean;
  error?: { code: string; detail: string };
}

const EMPTY: PVSearchResult = { status: 'idle', pvs: [], truncated: false };
const LOADING: PVSearchResult = { status: 'loading', pvs: [], truncated: false };

// A result and the archiver it was fetched from. Matches are only reported for
// that archiver: when a plot or trace switches archiver, the user must not be
// shown, and act on, PVs that exist only on the previous one.
interface Stored {
  archiver: string | undefined;
  result: PVSearchResult;
}

// The regex Mole hands to the archiver for what the user typed. The Archiver
// Appliance matches it against the whole PV name, so a bare glob such as
// `KLYS:LI2*:PDES` would be read as "LI" followed by any number of 2s and
// match nothing. Follow the Python Trace search dialog instead: `*` and `%`
// stand for any run of characters, `?` for one, and the result is unanchored
// so a fragment matches anywhere in the name. Other regex syntax passes
// through, and an explicit `.*`, `^` or `$` at either end is left alone, so
// `KLYS.*` and `^KLYS` keep meaning what they say. The group keeps an
// alternation such as `KLYS|FOO` inside the wrap. With a top-level alternation
// an end of the text belongs to one branch only, so `KLYS|FOO*` is wrapped on
// both sides: otherwise the KLYS branch would have to end the PV name.
export function toSearchRegex(text: string): string {
  // One pass, so a converted character is never read again: an escaped
  // character such as `\*` stays literal, `(?` keeps its group prefix, an
  // explicit `.*` stays as typed, and `?*` becomes `..*`.
  const body = text
    .trim()
    .replace(/\\.|\(\?|\.\*|[?*%]/g, (m) =>
      m[0] === '\\' || m === '(?' || m === '.*' ? m : m === '?' ? '.' : '.*'
    );
  const branches = hasTopLevelAlternation(body);
  const lead = !branches && (body.startsWith('^') || body.startsWith('.*')) ? '' : '.*';
  const tail = !branches && (body.endsWith('$') || body.endsWith('.*')) ? '' : '.*';
  return `${lead}(?:${body})${tail}`;
}

// A `|` outside every group and character class, and not escaped.
function hasTopLevelAlternation(regex: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < regex.length; i++) {
    const c = regex[i];
    if (c === '\\') i++;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return true;
  }
  return false;
}

export function usePVSearch(
  pattern: string,
  archiver: string | undefined,
  debounceMs = 300,
  limit = 50
): PVSearchResult {
  const conn = useCanopyConnection();
  const [stored, setStored] = useState<Stored>({ archiver, result: EMPTY });

  useEffect(() => {
    const trimmed = pattern.trim();
    if (trimmed.length < 1) {
      // Reset to empty when there's no query.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStored({ archiver, result: EMPTY });
      return;
    }

    const controller = new AbortController();
    const handle = setTimeout(() => {
      // Keep the previous matches listed while the next search on the same
      // archiver is in flight, so the list doesn't flash empty between
      // keystrokes.
      setStored((prev) => ({
        archiver,
        result: {
          status: 'loading',
          pvs: prev.archiver === archiver ? prev.result.pvs : [],
          truncated: false,
        },
      }));
      void (async () => {
        try {
          const dto = await searchPVs(
            conn,
            toSearchRegex(trimmed),
            { archiver, limit },
            controller.signal
          );
          if (controller.signal.aborted) return;
          // An appliance cluster can report the same PV once per appliance;
          // callers key rows by name, so list each PV once.
          setStored({
            archiver,
            result: {
              status: 'ready',
              pvs: [...new Set(dto.pvs)],
              truncated: dto.pvs.length >= limit,
            },
          });
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          const { code, detail } = errorInfo(err);
          setStored({
            archiver,
            result: { status: 'error', pvs: [], truncated: false, error: { code, detail } },
          });
        }
      })();
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [conn, pattern, archiver, debounceMs, limit]);

  // A blank pattern has nothing to show, even before the effect above resets.
  if (pattern.trim().length < 1) return EMPTY;
  // Until the effect above has run for a newly chosen archiver, the stored
  // matches belong to the previous one: report an empty search in flight.
  if (stored.archiver !== archiver && stored.result.status !== 'idle') return LOADING;
  return stored.result;
}
