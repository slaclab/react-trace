// Correlation's PVs: the roles its state puts PVs in (X, each Y, the trigger
// PV) and the React binding of the shared PV tracker (../shared/pvTracker.ts)
// over them, with Correlation's kind rule (scalar and enum).

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  CORRELATION_KINDS,
  PvTracker,
  type MetaPVService,
  type ProbeResult,
  type PvModel,
  type PvRole,
  type PvRoles,
} from '../shared/pvTracker';
import type { CorrelationState } from './query';

/** The PVs a state puts in roles; '' for an empty role. */
export function rolesOf(state: CorrelationState): PvRoles {
  return {
    x: state.x,
    ys: state.ys,
    trig: state.trigger.mode === 'pv' ? state.trigger.pv : '',
  };
}

export interface CorrelationPvs {
  model: PvModel;
  /** Check a typed PV before adding it; see `PvTracker.probe`. */
  probe: (pv: string, role: PvRole) => Promise<ProbeResult>;
  endProbe: (pv: string) => void;
}

/**
 * The tracker's model of `state`'s PVs over the instance's service. Listeners follow
 * the roles and are released on unmount.
 */
export function useCorrelationPvs(service: MetaPVService, state: CorrelationState): CorrelationPvs {
  const [tracker] = useState(() => new PvTracker(service, CORRELATION_KINDS));
  const roles = rolesOf(state);
  const rolesKey = JSON.stringify(roles);

  useEffect(() => {
    tracker.setRoles(JSON.parse(rolesKey) as PvRoles);
  }, [tracker, rolesKey]);

  useEffect(() => () => tracker.dispose(), [tracker]);

  const model = useSyncExternalStore(tracker.subscribe, tracker.getModel);
  return {
    model,
    probe: (pv, role) => tracker.probe(pv, role),
    endProbe: (pv) => tracker.endProbe(pv),
  };
}
