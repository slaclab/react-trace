// The Waveform tool root on the workbench.
//
//   - State: parsed once from the page URL (query.ts) and held here. Every
//     write goes through edit.ts — `update(fn)` commits `apply(prev, fn)`, so
//     each change ends in the normalizer and no caller holds a non-canonical
//     state. The embedded host is told of changes (stateOut.ts).
//   - Data: one `WaveformController` per mounted root, fed the page's Hare
//     service. It follows the state (listeners, rings, the forced publish on a
//     reference change), the page's visibility (hidden publishes nothing) and
//     Pause; the canvas reads its `frames` and `model`. StrictMode's double
//     mount disposes the controller and `setState` revives it.
//   - Workbench: `WorkbenchLayout` with Waveform's definition (Live /
//     Reference / X axis PV, the add rows probing over the same service) and
//     the model `{ waveform, fragmentInput }`; the canvas is its child slot.
//     The layout re-renders the properties panel only when what it shows
//     changed, so a stream of frames with unchanged status commits none of it.
//   - Canvas: the Plot draws live arrays, the reference, Δ, persistence,
//     averaging and statistics from state, model and frames alone, with the
//     health line for the Hare connection. It registers the actions bar's
//     list (tools/waveform/actions.ts): Pause, Snapshot → reference (one
//     click, replaces any reference, Δ re-zeroes on the forced publish),
//     Export CSV / PNG, Post to e-log under the `elog` capability, and
//     the standard actions.
//   - `onTool` hands the caller the tool's handle (update, the Snapshot
//     action, Pause).
//   - Drawings: the app keeps one record `{state, drawingHistory}`;
//     `writeApp` is its only setState. `update` applies `apply` then the
//     drawing-history transform, `undo` pops the ring (⌘Z, one listener). The
//     selection is a `SelectionStore` handed to the layout; Hide all is the
//     `ui` record's `drawingsHidden`; the link's shed counts go to a
//     `ShedStore` the canvas status line reads.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Theme } from '@carbon/react';
import type { HareConnectionStatus } from '@slaclab/canopy-client';
import { useColorMode, useHostTheme } from '@slaclab/canopy-shell';
import type { EChartsType } from 'echarts';
import { drawingThemeFor, type ChartDrawingTheme } from '../../annotationTheme';
import { useHostThemeId } from '../../state/colorMode';
import { pageConfigFile, useChartElogPost } from '../chartElogPost';
import { useStandardActionsOptions } from '../standardActionsOptions';
import {
  useWaveformCanvasActions,
  type WaveformActionsOptions,
  type WaveformCapabilities,
} from './actions';
import {
  createWaveformProbe,
  useWaveformDefinition,
  type WaveformToolModel,
  type WaveformUiRecord,
} from './tool';
import { WorkbenchLayout } from '../../workbench/WorkbenchLayout';
import { useContextMenuWriters } from '../../workbench/contextMenu/context';
import { waveformMenuWriters, type HeldShot, type WaveformMenuInput } from './menu';
import { createSelectionStore } from '../../workbench/selection';
import { WAVEFORM_CATALOG } from '../../annotations/catalog';
import {
  popRecordHistory,
  withRecordHistory,
  type DrawingHistoryState,
  type HistoryTag,
} from '../../annotations/history';
import { createShedStore } from '../../annotations/host/shedStore';
import { UndoKeyListener } from '../../annotations/host/UndoKeyListener';
import { useDrawingDocument } from '../../annotations/host/useDrawingDocument';
import { apply, setSnapshot } from './edit';
import {
  downloadWaveformCsv,
  downloadWaveformPng,
  waveformPngSource,
  type WaveformExport,
  type WaveformExportColumn,
} from './export';
import { deltaFrame } from './frames';
import { referenceFor } from './reference';
import type { WaveformModel } from './model';
import { WaveformPlot } from './Plot';
import { renderedXSource, type WaveformPlotInput } from './plotOption';
import { parseWaveformQuery, serializeWaveformQuery, type WaveformState } from './query';
import { useWaveformStateOut } from './stateOut';
import {
  WaveformController,
  type WaveformControllerOptions,
  type WaveformFrames,
  type WaveformPVService,
} from './WaveformController';

/** How often the health line re-reads the Hare connection status. */
export const HARE_STATUS_POLL_MS = 1000;

/** The page's Hare service as the root uses it: listeners, metadata and status. */
export interface WaveformHare extends WaveformPVService {
  readonly status: HareConnectionStatus;
}

/** The tool's handle: the state's one writer and the canvas actions. */
export interface WaveformTool {
  /** The latest committed state. */
  getState(): WaveformState;
  /** Commit `fn` over the latest state through edit.ts (normalized). */
  update(fn: (s: WaveformState) => WaveformState): void;
  /** Snapshot → reference; false when no curve has a published frame. */
  takeSnapshot(): boolean;
  /** Pause freezes the published frames; ingest continues. */
  setPaused(paused: boolean): void;
}

export interface WaveformAppProps {
  /** The page's one Hare service (created outside React by the entry). */
  hare: WaveformHare;
  /** Controller scheduling and clock; the browser's by default (tests fake them). */
  controllerOptions?: Omit<WaveformControllerOptions, 'service' | 'visible'>;
  /** Receives the tool's handle once, on mount. */
  onTool?: (tool: WaveformTool) => void;
}

/** The app record: the state and its drawing ring, never serialized. */
interface WaveformAppRecord {
  state: WaveformState;
  drawingHistory: DrawingHistoryState;
}

/** The one drawing document's id in the history ring. */
const DRAWING_DOC = 'waveform';

/** The PNG background per colour mode, as Trace's captures. */
function pngBackground(colorMode: 'light' | 'dark'): string {
  return colorMode === 'dark' ? '#161616' : '#ffffff';
}

export const NO_FRAME_REASON = 'Nothing published yet';
export const NO_SNAPSHOT_REASON = 'No live curve has data yet';

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** A curve's export name: its pinned Label, else the PV. */
function curveName(state: WaveformState, pv: string): string {
  return state.styles[pv]?.label ?? pv;
}

/**
 * What the canvas published, as the CSV export reads it: the drawn Live
 * curves in colour order (Δ when Δ is drawn), the PV reference as its own
 * column, the X source when it places the elements.
 */
function waveformExportOf(
  state: WaveformState,
  model: WaveformModel,
  frames: WaveformFrames,
  now: number
): WaveformExport {
  const delta = model.delta.on;
  const ref = state.reference;
  const curves: WaveformExportColumn[] = [];
  for (const row of model.live) {
    if (!row.drawable || row.hidden) continue;
    const frame = frames.live[row.pv]?.frame;
    if (frame === undefined) continue;
    let values: Float64Array | null = frame;
    if (delta) {
      const against = referenceFor(state, frames, row.pv)?.values ?? null;
      values = against ? deltaFrame(frame, against) : null;
    }
    if (values !== null) curves.push({ name: curveName(state, row.pv), values });
  }
  const refRow = model.reference;
  const reference =
    ref?.kind === 'pv' &&
    refRow !== null &&
    refRow.drawable &&
    !refRow.hidden &&
    frames.reference !== null
      ? { name: curveName(state, ref.pv), values: frames.reference }
      : null;
  const x =
    state.xs === ''
      ? null
      : {
          name: model.xAxis.label,
          values: frames.x,
          usable: model.xAxis.mode === 'source' && (model.x?.usable ?? false),
        };
  return { time: frames.time ?? now, curves, reference, x, range: state.elems, delta };
}

/** Registers Waveform's right-click writers with the workbench's menu host. */
function WaveformMenu({ input }: { input: WaveformMenuInput }) {
  useContextMenuWriters(waveformMenuWriters(input));
  return null;
}

/** Registers Waveform's actions in the workbench's actions bar from inside the canvas. */
function WaveformCanvasActions({ options }: { options: WaveformActionsOptions }) {
  useWaveformCanvasActions(options);
  return null;
}

const Canvas = memo(WaveformPlot);

export function WaveformApp({ hare, controllerOptions, onTool }: WaveformAppProps) {
  const [record, setRecord] = useState<WaveformAppRecord>(() => ({
    state: parseWaveformQuery(window.location.search),
    drawingHistory: { history: new Map() },
  }));
  const state = record.state;
  // The latest committed state, for the handle's reads between renders.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const { colorMode, carbonTheme } = useColorMode();
  // The root is the host-theme anchor, as in the main app (src/App.tsx).
  const { anchorRef, anchorProps } = useHostTheme<HTMLDivElement>(
    useHostThemeId() ?? colorMode,
    colorMode
  );
  const [shed] = useState(() => createShedStore());
  useWaveformStateOut(state, { shed, catalog: WAVEFORM_CATALOG });
  const standardOptions = useStandardActionsOptions(colorMode);

  // One controller per mounted root; the options are read at construction.
  const [controller] = useState(
    () => new WaveformController({ ...controllerOptions, service: hare, visible: pageVisible() })
  );
  useEffect(() => {
    controller.setState(state);
  }, [controller, state]);
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    const onVisibility = () => controller.setVisible(pageVisible());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [controller]);

  const frames = useSyncExternalStore(controller.subscribeFrames, controller.getFrames);
  const model = useSyncExternalStore(controller.subscribeModel, controller.getModel);

  // The SDK reports status only to its constructor's callback: poll it.
  const subscribeStatus = useCallback((onChange: () => void) => {
    const timer = window.setInterval(onChange, HARE_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const status = useSyncExternalStore(subscribeStatus, () => hare.status);

  // The record's only writer. `nowMs` is read outside the updater, so a
  // StrictMode double-invoke records one step.
  const writeApp = useCallback(
    (fn: (app: WaveformAppRecord) => WaveformAppRecord, tag?: HistoryTag) => {
      const nowMs = Date.now();
      setRecord((prev) => withRecordHistory(prev, fn(prev), tag, nowMs, DRAWING_DOC));
    },
    []
  );
  // Over the latest state, so two updates in one tick compose.
  const update = useCallback(
    (fn: (s: WaveformState) => WaveformState) =>
      writeApp((app) => {
        const next = apply(app.state, fn);
        return next === app.state ? app : { ...app, state: next };
      }),
    [writeApp]
  );
  const undo = useCallback(
    () =>
      writeApp(
        (app) =>
          popRecordHistory(app, DRAWING_DOC, (state, list) =>
            apply(state, (s) => ({ ...s, drawings: list }))
          ),
        'undo'
      ),
    [writeApp]
  );

  // ── Drawings ──────────────────────────────────────────────────────────────

  const [selection] = useState(() => createSelectionStore());
  const [ui, setUi] = useState<WaveformUiRecord>(() => ({}));
  const drawingDocument = useDrawingDocument({
    list: state.drawings,
    update,
    undo,
    selection,
    ui,
    setUi,
  });

  // Pause: the controller freezes at once; the toggle's pressed state follows.
  const [paused, setPausedState] = useState(false);
  const setPaused = useCallback(
    (next: boolean) => {
      controller.setPaused(next);
      setPausedState(next);
    },
    [controller]
  );

  const snapshotNow = useCallback((): boolean => {
    const snap = controller.captureSnapshot();
    if (snap === null) return false;
    // Replaces any reference; the reference change forces one publish, so
    // Δ re-zeroes on this click.
    update((s) => setSnapshot(s, snap));
    return true;
  }, [controller, update]);
  const tool = useMemo<WaveformTool>(
    () => ({
      getState: () => stateRef.current,
      update,
      takeSnapshot: () => snapshotNow(),
      setPaused,
    }),
    [snapshotNow, update, setPaused]
  );
  // The row's Snapshot → reference: the same capture, no return value.
  const takeSnapshot = useCallback(() => void snapshotNow(), [snapshotNow]);
  const onToolRef = useRef(onTool);
  useLayoutEffect(() => {
    onToolRef.current = onTool;
  });
  useEffect(() => {
    onToolRef.current?.(tool);
  }, [tool]);

  // ── Workbench ─────────────────────────────────────────────────────────────

  // The add rows' probe: the waveform kind rule over the page's service.
  const [probe] = useState(() => createWaveformProbe(hare));
  useEffect(() => () => probe.dispose(), [probe]);
  const renderedX = renderedXSource(model, frames);
  const definition = useWaveformDefinition({
    state,
    update,
    probe,
    drawings: state.drawings,
    renderedX,
    delta: model.delta.on,
    ui,
    setUi,
  });

  const chartTheme: ChartDrawingTheme = drawingThemeFor(colorMode);
  const chartRef = useRef<EChartsType | null>(null);
  const onChart = useCallback((chart: EChartsType | null) => {
    chartRef.current = chart;
  }, []);

  // The model the schemas read: the derived model and, for the Code tabs, the
  // chart-option input of a state over the latest published frames. Its
  // identity follows the frames; the workbench re-renders a pane only when
  // what it shows changed (rate rule).
  const toolModel = useMemo<WaveformToolModel>(
    () => ({
      waveform: model,
      fragmentInput: (s): WaveformPlotInput => {
        const css = chartRef.current?.getWidth?.() ?? 0;
        const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
        return {
          state: s,
          model,
          frames,
          widthPx: css > 0 ? css * dpr : Number.POSITIVE_INFINITY,
          theme: chartTheme,
        };
      },
    }),
    [model, frames, chartTheme]
  );

  // "Attach config": the page address that reopens this state.
  const buildConfigFile = useCallback(
    () => pageConfigFile(serializeWaveformQuery(stateRef.current), 'waveform_config.txt'),
    []
  );
  // The logbook listing loaded ⇒ Post to e-log is shown.
  const elogPost = useChartElogPost({ id: 'waveform', title: 'Waveform', buildConfigFile });
  const elog = elogPost.elog;
  const capabilities = useMemo<WaveformCapabilities>(() => ({ elog }), [elog]);

  // Freeze this shot: held beside the live curves until released; never saved.
  const [held, setHeld] = useState<HeldShot | null>(null);
  const plotFrames = useMemo(
    () => (held === null ? frames : { ...frames, held: held.live }),
    [frames, held]
  );

  const hasFrame = frames.time !== null;
  const hasLiveFrame = Object.values(frames.live).some((f) => f !== undefined);
  const snapshotDisabled = hasLiveFrame ? false : NO_SNAPSHOT_REASON;
  const actionOptions: WaveformActionsOptions = {
    handlers: {
      togglePause: () => setPaused(!paused),
      snapshot: takeSnapshot,
      exportCsv: () =>
        downloadWaveformCsv(waveformExportOf(stateRef.current, model, frames, Date.now())),
      exportPng: () => {
        const chart = chartRef.current;
        if (chart === null) return;
        downloadWaveformPng(
          chart,
          pngBackground(colorMode),
          frames.time ?? Date.now(),
          ui.drawingsHidden === true
        );
      },
      // The drawings ride along unless hidden.
      postElog: () => {
        const chart = chartRef.current;
        elogPost.post(
          chart && waveformPngSource(chart, ui.drawingsHidden === true),
          pngBackground(colorMode)
        );
      },
    },
    paused,
    capabilities,
    ...standardOptions,
    disabled: {
      snapshot: snapshotDisabled,
      'export-csv': hasFrame ? false : NO_FRAME_REASON,
      'export-png': hasFrame ? false : NO_FRAME_REASON,
    },
  };
  // Under the host bar the host's tile bar reads the state.
  const hostState = standardOptions.hostBar === true ? (paused ? 'paused' : 'live') : undefined;

  return (
    <Theme ref={anchorRef} {...anchorProps} theme={carbonTheme} style={{ height: '100%' }}>
      <main className="waveform-app" data-testid="waveform-app" style={{ height: '100%' }}>
        <WorkbenchLayout
          definition={definition}
          state={state}
          model={toolModel}
          ui={ui}
          selection={selection}
          update={update}
          capabilities={capabilities}
          toolId="waveform"
          hostState={hostState}
        >
          <WaveformCanvasActions options={actionOptions} />
          <WaveformMenu
            input={{
              state,
              model,
              frames,
              update,
              takeSnapshot: snapshotNow,
              snapshotDisabled,
              held,
              setHeld,
              chart: () => chartRef.current,
              background: pngBackground(colorMode),
              drawingsHidden: ui.drawingsHidden === true,
            }}
          />
          <Canvas
            state={state}
            model={model}
            frames={plotFrames}
            hare={status}
            chartTheme={chartTheme}
            onChart={onChart}
            drawingDocument={drawingDocument}
            shed={shed}
            update={update}
          />
          <UndoKeyListener onUndo={undo} />
        </WorkbenchLayout>
        {elogPost.modal}
      </main>
    </Theme>
  );
}
