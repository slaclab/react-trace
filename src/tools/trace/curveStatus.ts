// What Trace says about a PV curve's data sources: the Status lines of the
// curve's card (schema/curve.ts) and the hover text of its Signals row
// (outline.ts). The wording is the old Properties panel's and Layers rows':
//
//   Data points     the archive buffer's size while Archive is on, else the
//                   live buffer's while Live is on, else the curve's own data
//   Live status     Disabled · Connecting… · Connected · Waiting for value ·
//                   Disconnected
//   Severity        the PV's alarm severity, while Live is on and the PV is
//                   connected
//   Live error      the live connection's error message ("Live connection
//                   error.", or Hare's own error), while Live is on
//   Archive status  Disabled · Idle · Loading… · Loaded (raw|binned)
//                   [· decimated], or for an error its short name
//                   (`archiveErrorLabel`), else its code
//   Source          the archiver that answered, while Archive is on
//   Archive error   the archive error's detail, while Archive is on
//
// A row's hover text is a source's line with its detail after a dash:
// "Live: Disconnected — Live connection error.", "Archiver down — Appliance
// returned HTTP 503". Errors are read through the shared `errorInfo`.

import { archiveErrorLabel } from '../../api/archiveErrors';
import { errorInfo } from '../../api/errorInfo';
import type { ArchiveSeriesResult } from '../../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../../hooks/useLiveSeries';
import type { PVTrace } from '../../types';

type LiveResult = Pick<LiveSeriesResult, 'status' | 'connected'> &
  Partial<Pick<LiveSeriesResult, 'severity' | 'error' | 'points'>>;
type ArchiveResult = Pick<ArchiveSeriesResult, 'status'> &
  Partial<Pick<ArchiveSeriesResult, 'mode' | 'decimated' | 'error' | 'archiver' | 'mean'>>;

/** The Live status line. */
export function liveStatusLabel(
  trace: Pick<PVTrace, 'useLive'>,
  result: Pick<LiveSeriesResult, 'status' | 'connected'> | undefined
): string {
  if (!trace.useLive) return 'Disabled';
  const status = result?.status ?? 'idle';
  if (status === 'connecting') return 'Connecting…';
  if (status === 'connected') return result?.connected ? 'Connected' : 'Waiting for value';
  return 'Disconnected';
}

/** The Archive status line; an error reads as its short name, else its code. */
export function archiveStatusLabel(
  trace: Pick<PVTrace, 'useArchive'>,
  result: Pick<ArchiveSeriesResult, 'status' | 'mode' | 'decimated' | 'error'> | undefined
): string {
  if (!trace.useArchive) return 'Disabled';
  if (!result || result.status === 'idle') return 'Idle';
  if (result.status === 'loading') return 'Loading…';
  if (result.status === 'error') {
    const code = result.error?.code;
    return archiveErrorLabel(code) ?? code ?? 'Error';
  }
  const mode = result.mode === 'binned' ? ' (binned)' : ' (raw)';
  return `Loaded${mode}${result.decimated ? ' · decimated' : ''}`;
}

/** Data points: the archive buffer with Archive on, else the live buffer with Live on, else the curve's data. */
export function dataPointCount(
  trace: Pick<PVTrace, 'useLive' | 'useArchive' | 'data'>,
  live: LiveResult | undefined,
  archive: ArchiveResult | undefined
): number {
  if (trace.useArchive) return archive?.mean?.length ?? 0;
  if (trace.useLive) return live?.points?.length ?? 0;
  return trace.data.length;
}

/** The PV's alarm severity while Live is on and the PV is connected; none otherwise. */
export function liveSeverityText(
  trace: Pick<PVTrace, 'useLive'>,
  live: LiveResult | undefined
): string | undefined {
  if (!trace.useLive || !live?.connected || !live.severity) return undefined;
  return live.severity;
}

/** The live connection's error message while Live is on; none otherwise. */
export function liveErrorText(
  trace: Pick<PVTrace, 'useLive'>,
  live: LiveResult | undefined
): string | undefined {
  if (!trace.useLive || !live?.error) return undefined;
  return errorInfo(live.error).detail || undefined;
}

/** The archiver that answered, while Archive is on; none otherwise. */
export function archiveSourceText(
  trace: Pick<PVTrace, 'useArchive'>,
  archive: ArchiveResult | undefined
): string | undefined {
  if (!trace.useArchive) return undefined;
  return archive?.archiver || undefined;
}

/** The archive error's detail while Archive is on and failed; none otherwise. */
export function archiveErrorText(
  trace: Pick<PVTrace, 'useArchive'>,
  archive: ArchiveResult | undefined
): string | undefined {
  if (!trace.useArchive || archive?.status !== 'error') return undefined;
  return archive.error?.detail || undefined;
}

function withDetail(line: string, detail: string | undefined): string {
  const text = detail?.trim();
  return text && text !== line ? `${line} — ${text}` : line;
}

/** A Signals row's hover text for its live source: the status line, then the error message. */
export function liveRowText(trace: Pick<PVTrace, 'useLive'>, live: LiveResult | undefined): string {
  return withDetail(`Live: ${liveStatusLabel(trace, live)}`, liveErrorText(trace, live));
}

/** A Signals row's hover text for a failed archive: the error's short name, else its code, then the detail. */
export function archiveRowText(archive: ArchiveResult | undefined): string {
  const code = archive?.error?.code;
  const line = archiveErrorLabel(code) ?? `Archive: ${code || 'Error'}`;
  return withDetail(line, archive?.error?.detail);
}
