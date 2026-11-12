// The Correlation tool root on the workbench.
//
//   - State: parsed once from the page URL (query.ts) and held here, the
//     tool's owner. Every write goes through edit.ts — `update(fn)` commits
//     `apply(prev, fn)`, so each change ends in the normalizer and no caller
//     holds a non-canonical state. The embedded host is told of changes
//     (stateOut.ts). The colour mode is Trace's (state/colorMode.ts), so an embedding
//     host's theme messages reach this page the same way.
//   - Data: the PV tracker (pvs.ts) follows the state's roles and the Formula Engine
//     table (useTable.ts) is subscribed from state and the tracker's model;
//     Pause freezes the frame the canvas is handed.
//   - Workbench: `WorkbenchLayout` with Correlation's definition (X / Y /
//     Trigger, the add rows probing through the tracker, `pendingTrigger` in
//     the `ui` record) and the model `{ pvs, unitsOf, fragmentInput }`; the
//     canvas is its child slot. The view controls (View, Density Y, Y layout)
//     are Properties › View fields.
//   - Drawings: the app keeps one record
//     `{state, drawingHistory}`; `writeApp` is its only setState, `update`
//     runs edit.ts's normalizer under the drawing history transform, and
//     `undo` pops the ring (one document-level undo listener). The drawing
//     selection is the workbench `SelectionStore` App creates; hide-all is
//     the `ui` record's `drawingsHidden`; the link's shed counts reach the
//     status line through a `ShedStore`. The model carries the drawn X for
//     the workbench; the canvas stamps it on new drawings (`xRef`).
//   - Canvas: the health line, the chart, the readout and the strips. It
//     registers the actions bar's list (tools/correlation/actions.ts): Pause
//     (a pressed toggle), Clear, Export CSV / PNG (disabled until a frame
//     exists), Post to e-log under the `elog` capability, and the
//     standard actions.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Theme } from '@carbon/react';
import { useColorMode, useHostTheme } from '@slaclab/canopy-shell';
import type ReactECharts from 'echarts-for-react';
import { CORRELATION_CATALOG } from '../../annotations/catalog';
import {
  popRecordHistory,
  withRecordHistory,
  type DrawingHistoryState,
  type HistoryTag,
} from '../../annotations/history';
import { createShedStore } from '../../annotations/host/shedStore';
import { UndoKeyListener } from '../../annotations/host/UndoKeyListener';
import { useDrawingDocument } from '../../annotations/host/useDrawingDocument';
import { drawingThemeFor, type ChartDrawingTheme } from '../../annotationTheme';
import type { PvSearch } from '../../pvSearch';
import { useHostThemeId } from '../../state/colorMode';
import { pageConfigFile, useChartElogPost } from '../chartElogPost';
import { useStandardActionsOptions } from '../standardActionsOptions';
import {
  useCorrelationCanvasActions,
  type CorrelationActionsOptions,
  type CorrelationCapabilities,
} from './actions';
import {
  useCorrelationDefinition,
  useCorrelationUi,
  type CorrelationToolModel,
  type CorrelationUi,
} from './tool';
import { createSelectionStore } from '../../workbench/selection';
import { useContextMenuWriters } from '../../workbench/contextMenu/context';
import { correlationMenuWriters, type CorrelationMenuInput } from './menu';
import { WorkbenchLayout } from '../../workbench/WorkbenchLayout';
import { apply } from './edit';
import { downloadCsv } from './export';
import { HealthBar } from './HealthBar';
import type { HealthPVSource } from './health';
import {
  CorrelationCanvas,
  correlationPlotInput,
  downloadChartPng,
  useCorrelationFrame,
} from './Plot';
import { useCorrelationPvs } from './pvs';
import { parseCorrelationQuery, serializeCorrelationQuery, type CorrelationState } from './query';
import { useCorrelationStateOut } from './stateOut';
import { useTable, type FormulaEngineFactory } from './useTable';
import './correlation.css';
import { chartPngSource } from '../shared/chartImage';
import { type MetaPVService } from '../shared/pvTracker';

export interface CorrelationAppProps {
  /** The instance's Hare service: PV metadata and per-PV status. */
  hare: MetaPVService & HealthPVSource;
  /** Builds the instance's Formula Engine service; the SDK's by default. */
  createFormulaEngine?: FormulaEngineFactory;
  /** The add rows' PV search; the workbench default when absent. */
  search?: PvSearch;
}

/** Why Export is disabled before the first frame. */
export const NO_FRAME_REASON = 'Nothing to export yet';

/** Registers Correlation's actions in the workbench's actions bar from inside the canvas. */
function CorrelationCanvasActions({ options }: { options: CorrelationActionsOptions }) {
  useCorrelationCanvasActions(options);
  return null;
}

/** The app record: the tool's state and its drawing ring, never serialized. */
interface CorrelationAppRecord {
  state: CorrelationState;
  drawingHistory: DrawingHistoryState;
}

/** The ring's one document: Correlation's drawing list. */
const DRAWINGS_DOC = 'correlation';

/** Registers Correlation's right-click writers with the workbench's menu host. */
function CorrelationMenu({ input }: { input: CorrelationMenuInput }) {
  useContextMenuWriters(correlationMenuWriters(input));
  return null;
}

export function CorrelationApp({ hare, createFormulaEngine, search }: CorrelationAppProps) {
  const [record, setRecord] = useState<CorrelationAppRecord>(() => ({
    state: parseCorrelationQuery(window.location.search),
    drawingHistory: { history: new Map() },
  }));
  const state = record.state;
  // The latest committed state, for "Attach config" between renders.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [paused, setPaused] = useState(false);
  const { colorMode, carbonTheme } = useColorMode();
  // The zone is the host-theme anchor, as in the main app (src/App.tsx).
  const { anchorRef, anchorProps } = useHostTheme<HTMLDivElement>(
    useHostThemeId() ?? colorMode,
    colorMode
  );
  // What the last link shed, for the drawing status line.
  const [shed] = useState(createShedStore);
  useCorrelationStateOut(state, { shed, catalog: CORRELATION_CATALOG });
  const standardOptions = useStandardActionsOptions(colorMode);

  // The record's only setState. `nowMs` is read outside the updater, so a
  // StrictMode double-invoke records one step; a write that changes the
  // drawing list's identity records an undo step.
  const writeApp = useCallback(
    (fn: (app: CorrelationAppRecord) => CorrelationAppRecord, tag?: HistoryTag) => {
      const nowMs = Date.now();
      setRecord((prev) => withRecordHistory(prev, fn(prev), tag, nowMs, DRAWINGS_DOC));
    },
    []
  );
  // The tool's one writer: over the latest state, so two updates in one tick
  // compose, and through edit.ts's normalizer (reference-preserving).
  const update = useCallback(
    (fn: (s: CorrelationState) => CorrelationState) =>
      writeApp((a) => {
        const next = apply(a.state, fn);
        return next === a.state ? a : { ...a, state: next };
      }),
    [writeApp]
  );
  // Undo the newest drawing edit.
  const undo = useCallback(
    () =>
      writeApp(
        (a) =>
          // The ring holds the lists it was given: the state's own arrays.
          popRecordHistory(a, DRAWINGS_DOC, (state, list) => ({ ...state, drawings: list })),
        'undo'
      ),
    [writeApp]
  );

  const pvs = useCorrelationPvs(hare, state);
  const { frame, health, retry } = useTable({
    state,
    model: pvs.model,
    paused,
    hare,
    createFormulaEngine,
  });
  const onScreen = useCorrelationFrame(frame, state.metrics, state.readout);
  // The X the canvas draws: the frame's X PV, else the state's.
  const drawnX = onScreen.shown?.columnPvs.x ?? state.x;

  const pvModel = pvs.model;
  const unitsOf = useCallback(
    (pv: string) => {
      if (pvModel.x?.pv === pv) return pvModel.x.units;
      return pvModel.ys.find((info) => info.pv === pv)?.units ?? '';
    },
    [pvModel]
  );

  const chartTheme: ChartDrawingTheme = drawingThemeFor(colorMode);
  const chartRef = useRef<ReactECharts>(null);

  // ── Workbench ─────────────────────────────────────────────────────────────

  // The model the schemas and the binding read: the tracker's model, the
  // units and, for the Code tabs, the chart-option input of a state over the
  // frame on screen. Its identity follows the frame; the workbench re-renders
  // a pane only when what it shows changed (rate rule).
  const shown = onScreen.shown;
  const toolModel = useMemo<CorrelationToolModel>(
    () => ({
      pvs: pvModel,
      unitsOf,
      drawnX,
      fragmentInput: (s) =>
        correlationPlotInput(s, shown, {
          unitsOf,
          theme: chartTheme,
          width: chartRef.current?.getEchartsInstance()?.getWidth?.() ?? 0,
        }),
    }),
    [pvModel, unitsOf, shown, chartTheme, drawnX]
  );
  const ui = useCorrelationUi();

  // ── Drawings ─────────────────────────────────────────────────────────

  const [selection] = useState(() => createSelectionStore());
  const drawingDocument = useDrawingDocument<CorrelationState, CorrelationUi>({
    list: state.drawings,
    update,
    undo,
    selection,
    ui,
    setUi: ui.setUi,
  });
  const drawing = useMemo(() => ({ document: drawingDocument, shed }), [drawingDocument, shed]);
  const definition = useCorrelationDefinition({
    state,
    model: toolModel,
    update,
    pvs,
    ui,
    search,
  });

  // "Attach config": the page address that reopens this state.
  const buildConfigFile = useCallback(
    () => pageConfigFile(serializeCorrelationQuery(stateRef.current), 'correlation_config.txt'),
    []
  );
  // The logbook listing loaded ⇒ Post to e-log is shown.
  const elogPost = useChartElogPost({ id: 'correlation', title: 'Correlation', buildConfigFile });
  const elog = elogPost.elog;
  const capabilities = useMemo<CorrelationCapabilities>(() => ({ elog }), [elog]);

  const noFrame: string | false = shown === null ? NO_FRAME_REASON : false;
  const disabled = { 'export-csv': noFrame, 'export-png': noFrame };
  const togglePause = () => setPaused((p) => !p);
  const actionOptions: CorrelationActionsOptions = {
    handlers: {
      togglePause,
      clear: onScreen.clear,
      exportCsv: () => {
        if (shown !== null) downloadCsv(shown, onScreen.cut);
      },
      exportPng: () => downloadChartPng(chartRef.current, shown, chartTheme, ui.drawingsHidden),
      postElog: () => {
        const instance = chartRef.current?.getEchartsInstance();
        elogPost.post(instance && chartPngSource(instance, ui.drawingsHidden), chartTheme.bg);
      },
    },
    paused,
    capabilities,
    ...standardOptions,
    disabled,
  };
  // Under the host bar the host's tile bar reads the state.
  const hostState = standardOptions.hostBar === true ? (paused ? 'paused' : 'live') : undefined;

  return (
    <Theme ref={anchorRef} {...anchorProps} theme={carbonTheme} style={{ height: '100%' }}>
      <main className="correlation-app" data-testid="correlation-app">
        <WorkbenchLayout
          definition={definition}
          state={state}
          model={toolModel}
          ui={ui}
          update={update}
          capabilities={capabilities}
          selection={selection}
          toolId="correlation"
          hostState={hostState}
        >
          <UndoKeyListener onUndo={undo} />
          <CorrelationCanvasActions options={actionOptions} />
          <CorrelationMenu
            input={{
              state,
              shown,
              pvs: pvModel,
              unitsOf,
              update,
              chart: () => chartRef.current?.getEchartsInstance() ?? null,
              background: chartTheme.bg,
              drawingsHidden: ui.drawingsHidden === true,
            }}
          />
          <div className="correlation-app__canvas">
            <HealthBar health={health} onRetry={retry} />
            <CorrelationCanvas
              state={state}
              frame={onScreen}
              unitsOf={unitsOf}
              chartTheme={chartTheme}
              chartRef={chartRef}
              drawing={drawing}
              update={update}
            />
          </div>
        </WorkbenchLayout>
        {elogPost.modal}
      </main>
    </Theme>
  );
}
