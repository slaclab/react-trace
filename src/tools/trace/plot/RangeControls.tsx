// Time-range chips for every plot mount.
//
// One strip — 1h / 6h / 24h presets, All, a datetime-local "go to", and Now —
// mounted in the tab bar for the active plot, in each grid cell's chrome for
// that cell's plot, in the fullscreen header and in a detached window's title
// bar, so every mount site can move its plot's window the same way.
//
// Every control writes a whole, FRESH `xAxis` through `onApplyXAxis` (the new
// identity drops the view window and re-enables autoscroll), so
// re-picking the active preset still snaps back to the live range:
//   - a preset   → `{ ...xAxis, timeRange: preset }`;
//   - All        → `allLoadedXAxis(…)` resolved at click time; disabled when null;
//   - go to      → `custom` From/To of the current span centred on the date,
//                  From floored and To ceiled to whole minutes, ≥ 1 min apart;
//   - Now        → `{ ...xAxis, timeRange: lastRelativeSpan ?? '-1h' }`.
//
// The root carries `data-range-controls` and stops native pointerdown/mousedown
// propagation, so a press on a chip never starts a plot gesture.
//
// No colour/font literals here (kept literal-free since its move out of the literal-guarded src/annotations).
import { useRef, useState, type KeyboardEvent } from 'react';
import type { Plot } from '../../../types';
import { TIME_RANGE_PRESETS } from '../fields/timeRange';
import { nsToMs, resolveTimeWindow, toDatetimeLocal, type TimeWindowNs } from '../../../api/time';
import { stopPressPropagation } from '../../../plot/geometry';
import { allLoadedWindow, allLoadedXAxis, type LoadedResults } from '../drawing/time';

const MINUTE_MS = 60_000;

/** The chip presets: values from the shared list, short labels for the strip. */
const CHIP_LABELS: ReadonlyMap<string, string> = new Map([
  ['-1h', '1h'],
  ['-6h', '6h'],
  ['-1d', '24h'],
]);

// eslint-disable-next-line react-refresh/only-export-components -- shared with the tests
export const RANGE_CHIPS: readonly { value: string; label: string }[] = TIME_RANGE_PRESETS.filter(
  (p) => CHIP_LABELS.has(p.value)
).map((p) => ({ value: p.value, label: CHIP_LABELS.get(p.value)! }));

/** Now's fallback when the plot never showed a relative range this session. */
const DEFAULT_NOW_RANGE = '-1h';

/**
 * The `custom` xAxis of a `spanMs`-wide window centred on `centerMs`: From
 * floored and To ceiled to whole minutes (datetime-local has no seconds), and
 * at least one minute apart, so a sub-minute span still yields From < To.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, tested directly
export function goToXAxis(xAxis: Plot['xAxis'], centerMs: number, spanMs: number): Plot['xAxis'] {
  const half = Math.max(0, spanMs) / 2;
  const from = Math.floor((centerMs - half) / MINUTE_MS) * MINUTE_MS;
  const to = Math.max(Math.ceil((centerMs + half) / MINUTE_MS) * MINUTE_MS, from + MINUTE_MS);
  return {
    ...xAxis,
    timeRange: 'custom',
    timeFrom: toDatetimeLocal(from),
    timeTo: toDatetimeLocal(to),
  };
}

export interface RangeControlsProps {
  /** The plot's current xAxis; every write keeps its other fields. */
  xAxis: Plot['xAxis'];
  /** The plot's display window; its span is go-to's span. Absent = the xAxis's own. */
  viewWindowNs?: TimeWindowNs;
  /** The plot's loaded buffers, for All. */
  results: LoadedResults;
  /** The plot's visible trace ids, for All. */
  visibleTraceIds: readonly string[];
  /** The last relative range the plot showed this session (Now's target). */
  getLastRelativeSpan?: () => string | undefined;
  onApplyXAxis?: (xAxis: Plot['xAxis']) => void;
}

const chipStyle = (active: boolean, disabled = false) => ({
  padding: '2px 6px',
  border: '1px solid var(--cds-border-subtle)',
  borderRadius: 2,
  background: active ? 'var(--cds-layer-selected)' : 'var(--cds-layer)',
  color: disabled ? 'var(--cds-text-disabled)' : 'var(--cds-text-primary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '16px',
  cursor: disabled ? 'default' : 'pointer',
});

export function RangeControls({
  xAxis,
  viewWindowNs,
  results,
  visibleTraceIds,
  getLastRelativeSpan,
  onApplyXAxis,
}: RangeControlsProps) {
  const [draft, setDraft] = useState('');
  // The go-to value last applied, so a blur after Enter does not write twice.
  const committed = useRef('');
  const apply = (next: Plot['xAxis']) => onApplyXAxis?.(next);
  // Enabled whenever a visible curve holds a sample; the click resolves the
  // span against the clock (a sub-second span then writes nothing).
  const allAvailable = allLoadedWindow(results, visibleTraceIds, 0) !== null;

  const goTo = () => {
    const centerMs = new Date(draft).getTime();
    if (!draft || !Number.isFinite(centerMs)) return;
    committed.current = draft;
    const w = viewWindowNs ?? resolveTimeWindow(xAxis, Date.now()).window;
    apply(goToXAxis(xAxis, centerMs, nsToMs(w.toNs) - nsToMs(w.fromNs)));
  };
  const onGoToKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goTo();
    }
  };

  return (
    <div
      ref={stopPressPropagation}
      data-range-controls=""
      role="group"
      aria-label="Time range"
      style={{ display: 'flex', alignItems: 'center', gap: 2 }}
    >
      {RANGE_CHIPS.map((chip) => {
        const active = xAxis.timeRange === chip.value;
        return (
          <button
            key={chip.value}
            type="button"
            data-range-chip={chip.value}
            aria-pressed={active}
            title={`Last ${chip.label}`}
            style={chipStyle(active)}
            onClick={() => apply({ ...xAxis, timeRange: chip.value })}
          >
            {chip.label}
          </button>
        );
      })}
      <button
        type="button"
        data-range-chip="all"
        title="Everything loaded"
        disabled={!allAvailable}
        style={chipStyle(false, !allAvailable)}
        onClick={() => {
          const all = allLoadedXAxis(xAxis, results, visibleTraceIds, Date.now());
          if (all) apply(all);
        }}
      >
        All
      </button>
      <input
        type="datetime-local"
        data-range-goto=""
        aria-label="Go to date and time"
        title="Go to (Enter)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onGoToKey}
        onBlur={() => {
          if (draft !== committed.current) goTo();
        }}
        style={{ ...chipStyle(false), cursor: 'text' }}
      />
      <button
        type="button"
        data-range-chip="now"
        title="Back to now"
        style={chipStyle(false)}
        onClick={() => apply({ ...xAxis, timeRange: getLastRelativeSpan?.() ?? DEFAULT_NOW_RANGE })}
      >
        Now
      </button>
    </div>
  );
}
