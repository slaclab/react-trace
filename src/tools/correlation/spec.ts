// The Formula Engine `table` spec of a correlation plot: what the tab subscribes
// to, built from its state and the PV tracker's model.
//
//   - one binding per distinct PV: X binds `x`, Y columns bind their column
//     name, the trigger binds `trig`; a PV already bound (Y = X, trigger = X)
//     reuses its binding, as the contract fixtures do;
//   - columns `x` and `y` (one Y) or `y1..yk` (several Ys), each a bare
//     binding, in the plotted Ys' colour order; refused Ys are left out;
//   - Trigger PV mode is `first_input` on the trigger binding; Timer mode is
//     `grid` with Δt in ns. Raw mode, last-value alignment, `maxPoints` = N;
//   - Fire on: PV mode adds `triggerEdge` right after `trigger`
//     only for Rising or Falling, as canopy's trigger-edge fixtures order it.
//     Every update and Timer specs carry no such key, so their bytes — and
//     their subscription keys — are what they were before Fire on existed
//     (the server rejects `triggerEdge` on a `grid` index);
//   - the window start is `t0Ns` = −lookback in ns (a table always subscribes
//     with t0Ns < 0; the server derives its own poll interval, so none is sent).
//
// A spec is built only after the tracker's kind and unit decision for its PVs: while the
// model does not yet describe the state's PVs, or any role PV is still within
// its metadata window, the result is `undecided` and the caller keeps what it
// has. `none` means no spec can be built: no X, no accepted Y, or a refused
// trigger.

import type { FormulaSpec } from '@slaclab/canopy-client';
import { lookbackMs, type CorrelationState, type CorrelationTrigger } from './query';
import { isPlotted, type PvInfo, type PvModel } from '../shared/pvTracker';

export interface TableSpec {
  spec: FormulaSpec;
  /** Window start, negative: −lookback in ns. */
  t0Ns: number;
  /** Column name → PV, for the plot, legend, readout and CSV. */
  columnPvs: Record<string, string>;
  /** Binding token → PV, for the per-input health of a result frame. */
  bindingPvs: Record<string, string>;
  trigger: CorrelationTrigger;
  /** Identity of the subscription: equal keys subscribe the same thing. */
  key: string;
}

export type TableSpecResult =
  | { kind: 'none' }
  | { kind: 'undecided' }
  | { kind: 'ready'; table: TableSpec };

const NONE: TableSpecResult = { kind: 'none' };
const UNDECIDED: TableSpecResult = { kind: 'undecided' };

const NS_PER_MS = 1_000_000;
const NS_PER_S = 1_000_000_000;

function sameNames(infos: PvInfo[], names: string[]): boolean {
  return infos.length === names.length && infos.every((info, i) => info.pv === names[i]);
}

export function buildTableSpec(state: CorrelationState, model: PvModel): TableSpecResult {
  const ys = state.ys.filter((y) => y !== '');
  const trigPv = state.trigger.mode === 'pv' ? state.trigger.pv : '';
  if (state.x === '' || ys.length === 0) return NONE;
  if (state.trigger.mode === 'pv' && trigPv === '') return NONE;

  // The model follows the state one effect later; until it describes the
  // same PVs it says nothing about them.
  if (model.x?.pv !== state.x || !sameNames(model.ys, ys)) return UNDECIDED;
  if (trigPv !== '' && model.trig?.pv !== trigPv) return UNDECIDED;

  const x = model.x;
  const trig = trigPv === '' ? null : model.trig;
  if (x.status === 'pending' || trig?.status === 'pending' || !model.decided) return UNDECIDED;
  if (!isPlotted(x) || (trig !== null && !isPlotted(trig))) return NONE;
  const plotted = model.ys.filter((y) => isPlotted(y));
  if (plotted.length === 0) return NONE;

  const bindings: Record<string, string> = {};
  const bindingOf = new Map<string, string>();
  const bind = (pv: string, name: string): string => {
    const existing = bindingOf.get(pv);
    if (existing !== undefined) return existing;
    bindings[name] = pv;
    bindingOf.set(pv, name);
    return name;
  };

  const columns: Record<string, string> = { x: `{${bind(x.pv, 'x')}}` };
  const columnPvs: Record<string, string> = { x: x.pv };
  plotted.forEach((y, i) => {
    const column = plotted.length === 1 ? 'y' : `y${i + 1}`;
    columns[column] = `{${bind(y.pv, column)}}`;
    columnPvs[column] = y.pv;
  });

  const spec: FormulaSpec =
    state.trigger.mode === 'pv' && trig !== null
      ? {
          kind: 'table',
          index: 'first_input',
          mode: 'raw',
          align: 'last',
          bindings,
          columns,
          trigger: bind(trig.pv, 'trig'),
          ...(state.fire !== undefined ? { triggerEdge: state.fire } : {}),
          maxPoints: state.n,
        }
      : {
          kind: 'table',
          index: 'grid',
          mode: 'raw',
          align: 'last',
          gridDtNs: Math.round((state.trigger.mode === 'timer' ? state.trigger.dtS : 1) * NS_PER_S),
          bindings,
          columns,
          maxPoints: state.n,
        };
  const t0Ns = -lookbackMs(state) * NS_PER_MS;
  const bindingPvs = { ...bindings };

  return {
    kind: 'ready',
    table: {
      spec,
      t0Ns,
      columnPvs,
      bindingPvs,
      trigger: state.trigger,
      key: JSON.stringify([spec, t0Ns]),
    },
  };
}
