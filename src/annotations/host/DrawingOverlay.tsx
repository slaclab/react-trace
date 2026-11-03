// The visual drawing parts a plot places, each driven by the host from
// `useDrawingHost`:
//   - `<DrawingLayers host>`: the per-grid svgs (one `AnnotationLayer`, which
//     renders one svg per grid and holds the gesture behind the host's
//     overlay ref);
//   - `<DrawingRailFor host>`: the rail over the host's catalog, with the
//     shared strip toggles.
// The in-place note editor needs no part of its own: the layer renders it as
// the svgs' sibling (never part of the PNG capture), since it edits the
// gesture the layer holds.
// A plot places the two where its DOM needs them; Trace keeps `AxisBadges`
// between the svgs and the rail.
//
// Neither keeps reducer state or subscribes to `config.frames`: a frame bump
// commits nothing here; only the measure card inside the layer re-reads.
//
// No colour/font literals here (src/annotations is literal-guarded).
import { AnnotationLayer, type AnnotationLayerProps } from '../AnnotationLayer';
import { DrawingRail } from '../DrawingRail';
import type { PlotView } from '../../plot/plotToggles';
import type { DrawingHost } from './useDrawingHost';

/** Layer props a plot may pass through (a fixed draft, the chart tooltip forwarder). */
export type DrawingLayerExtras = Partial<Pick<AnnotationLayerProps, 'draft' | 'showTip'>>;

export interface DrawingLayersProps extends DrawingLayerExtras {
  host: DrawingHost;
}

/**
 * The per-grid drawing svgs. Reads the host's document (list, selection,
 * prefs, hide-all) and config, and binds the gesture's handle to the host.
 */
export function DrawingLayers({ host, ...extras }: DrawingLayersProps) {
  const { document: doc } = host;
  return (
    <AnnotationLayer
      projectionStore={host.projectionStore}
      annotations={doc.annotations}
      axes={host.axes}
      theme={host.theme}
      annotationsHidden={doc.hidden}
      selectedId={doc.selectedId}
      prefs={doc.prefs}
      onPrefs={doc.setPrefs}
      onCommit={doc.commit}
      onSelectAnnotation={doc.select}
      showTip={host.showTip}
      overlayRef={host.overlayRef}
      config={host.config}
      {...extras}
    />
  );
}

export interface DrawingRailForProps {
  host: DrawingHost;
  /** Focuses the plot root after a rail press (`focus({ preventScroll: true })`). */
  focusRoot?: () => void;
  /** The plot's view settings (tooltip, drag mode), from the tool's state. */
  view?: PlotView;
  /** Patches the plot's view settings in the tool's state. */
  onView?: (patch: Partial<PlotView>) => void;
}

/**
 * The drawing rail over the host's catalog. The hide-all toggle is offered
 * only when the document has a hide-all writer, the view toggles only with a
 * view and its writer.
 */
export function DrawingRailFor({ host, focusRoot, view, onView }: DrawingRailForProps) {
  const { document: doc, config } = host;
  return (
    <DrawingRail
      prefs={doc.prefs}
      onPrefs={doc.setPrefs}
      hidden={doc.hidden}
      onHiddenChange={doc.setHidden}
      view={view}
      onView={onView}
      focusRoot={focusRoot}
      catalog={config.catalog}
    />
  );
}
