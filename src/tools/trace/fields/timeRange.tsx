// Trace's Time range custom field. The value is the plot's `xAxis`, which is
// what `range=` carries: a relative span (`-30s`, `-1h`, `-90m`) or `custom`
// with From/To. The preset Select carries the field's `#time-range` hook; a
// relative range offers a free-text span (`#time-span`), a custom range the
// From/To inputs and the resolver's error.

import { useState, type ReactNode } from 'react';
import { Select, SelectItem, TextInput } from '@carbon/react';
import { parseSpanMs, resolveTimeWindow } from '../../../api/time';
import type { Plot } from '../../../types';

export type TimeRangeValue = Plot['xAxis'];

/** The relative-range presets, in menu order. The one list the Properties
 *  field, the tab-bar chips and the time-band menu render from. Last 1 Minute
 *  is `-1m`, the value a typed `1m` span commits, so the two never show as
 *  separate options. */
// eslint-disable-next-line react-refresh/only-export-components -- shared with the tab-bar chips and the time-band menu
export const TIME_RANGE_PRESETS: readonly { value: string; label: string }[] = [
  { value: '-30s', label: 'Last 30 Seconds' },
  { value: '-1m', label: 'Last 1 Minute' },
  { value: '-5m', label: 'Last 5 Minutes' },
  { value: '-15m', label: 'Last 15 Minutes' },
  { value: '-1h', label: 'Last 1 Hour' },
  { value: '-4h', label: 'Last 4 Hours' },
  { value: '-6h', label: 'Last 6 Hours' },
  { value: '-1d', label: 'Last 1 Day' },
  { value: '-2d', label: 'Last 2 Days' },
  { value: '-1w', label: 'Last 1 Week' },
  { value: '-1M', label: 'Last 1 Month' },
];

const CUSTOM_RANGE = 'custom';

const SPAN_ERROR = 'Use a number plus s, m, h, d, w, or M (e.g. 30s, 90m, 1.5h, 2w).';

export interface TimeRangeControlProps {
  /** The Select's `#id` (the field's Properties hook). */
  id?: string;
  value: TimeRangeValue;
  onChange(value: TimeRangeValue): void;
}

export function TimeRangeControl({ id, value, onChange }: TimeRangeControlProps): ReactNode {
  const isCustom = value.timeRange === CUSTOM_RANGE;
  const spanFromRange = isCustom ? '' : value.timeRange.replace(/^-/, '');
  const [spanText, setSpanText] = useState(spanFromRange);
  const [spanError, setSpanError] = useState<string | undefined>(undefined);
  // Re-sync from an outside change (load, undo, reset) during render, tracking
  // the range last synced from so typing between renders is not lost.
  const [syncedFrom, setSyncedFrom] = useState(value.timeRange);
  if (value.timeRange !== syncedFrom) {
    setSyncedFrom(value.timeRange);
    setSpanText(spanFromRange);
    setSpanError(undefined);
  }

  const commitSpan = () => {
    const trimmed = spanText.trim();
    if (trimmed === '') {
      setSpanError(undefined);
      return;
    }
    if (parseSpanMs(trimmed) === null) {
      setSpanError(SPAN_ERROR);
      return;
    }
    setSpanError(undefined);
    const next = `-${trimmed}`;
    if (next !== value.timeRange) onChange({ ...value, timeRange: next });
  };

  // A blank To means now: the custom range is checked against the time of the
  // last edit here, so rendering stays pure.
  const [checkedAtMs, setCheckedAtMs] = useState(Date.now);
  const edit = (next: TimeRangeValue) => {
    setCheckedAtMs(Date.now());
    onChange(next);
  };
  const customError = isCustom ? resolveTimeWindow(value, checkedAtMs).error : undefined;
  // A relative range that is not a preset needs its own option, or the native
  // Select would show the first preset.
  const isPreset =
    isCustom || TIME_RANGE_PRESETS.some((preset) => preset.value === value.timeRange);

  return (
    <div className="trace-time-range">
      <Select
        id={id ?? 'time-range-select'}
        labelText="Time range"
        hideLabel
        size="sm"
        value={value.timeRange}
        onChange={(e) => {
          setSpanError(undefined);
          edit({ ...value, timeRange: e.target.value });
        }}
      >
        {TIME_RANGE_PRESETS.map((preset) => (
          <SelectItem key={preset.value} value={preset.value} text={preset.label} />
        ))}
        {!isPreset && (
          <SelectItem value={value.timeRange} text={`Last ${value.timeRange.replace(/^-/, '')}`} />
        )}
        <SelectItem value={CUSTOM_RANGE} text="Custom Range..." />
      </Select>
      {!isCustom && (
        <TextInput
          id="time-span"
          labelText="Span (e.g. 30s, 90m, 1.5h, 2w)"
          size="sm"
          value={spanText}
          invalid={!!spanError}
          invalidText={spanError}
          onChange={(e) => setSpanText(e.target.value)}
          onBlur={commitSpan}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitSpan();
          }}
        />
      )}
      {isCustom && (
        <>
          <TextInput
            id="time-from"
            labelText="From"
            type="datetime-local"
            size="sm"
            value={value.timeFrom ?? ''}
            onChange={(e) => edit({ ...value, timeFrom: e.target.value })}
          />
          <TextInput
            id="time-to"
            labelText="To (blank = now)"
            type="datetime-local"
            size="sm"
            value={value.timeTo ?? ''}
            onChange={(e) => edit({ ...value, timeTo: e.target.value })}
          />
          {customError && (
            <div className="trace-time-range__error" role="alert">
              {customError}
            </div>
          )}
        </>
      )}
    </div>
  );
}
