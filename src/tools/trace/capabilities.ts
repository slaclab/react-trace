// Trace's one capability record, computed once per tool and read by schemas
// and canvas actions, so no schema calls `isEmbedded()`.
//
// - `elog`: Canopy's e-log config says enabled (`useElogConfig`); while it is
//   still loading, or failed, Post to e-log is hidden. Standalone and embedded
//   alike: whether e-log is available is Canopy's config, not the embedding.
//
// Formulas need no flag: formula REST calls resolve against the Canopy base
// (`canopyConnection`), and embedded the host relays the Formula Engine's
// validate and evaluate POSTs, so standalone and embedded alike validate and
// draw formula curves.

import { useMemo } from 'react';
import { useElogConfig } from '../../hooks/useElogConfig';
import type { Capabilities } from '../../workbench/types';

export interface TraceCapabilities extends Capabilities {
  elog: boolean;
}

/** The record from its inputs; pure, so tests and non-React callers can build it. */
export function traceCapabilities(inputs: { elog: boolean }): TraceCapabilities {
  return { elog: inputs.elog };
}

/** The record for the mounted Trace tool; its identity changes only when the e-log config resolves. */
export function useTraceCapabilities(): TraceCapabilities {
  const elog = useElogConfig()?.enabled ?? false;
  return useMemo(() => traceCapabilities({ elog }), [elog]);
}
