// The style panel of the selected drawing: a small chip beside the drawing
// that opens a panel of colour swatches and line samples, the way a drawing
// app restyles a selected shape in place.
//
//   - Colour: round swatches. The theme's ink first (the default), then the
//     plotted curves' colours (so a drawing can match its curve), then the
//     accent palette. A colour already offered earlier in the row is not
//     repeated.
//   - Line: one sample per offered width (`STYLE_WIDTHS`), drawn at that
//     width, and a solid / dashed pair.
//
// Every choice is one commit through the drawing's own `color` / `width` /
// `dash` fields, so it is undoable and saved like any edit. The panel is HTML
// beside the overlay svgs (never part of the PNG capture). It is plot chrome:
// presses, double-clicks and wheel turns stop at its root, so they never
// reach the wrapper's gestures, and Escape closes it.
//
// No colour/font literals here (src/annotations is literal-guarded): the
// swatches show theme and curve colours, the chrome uses Carbon variables.
import { useEffect, useState, type CSSProperties } from 'react';
import { ANNOTATION_INK } from '../annotationTheme';
import { swatchRow } from './style';
import type { DrawingTheme, GridRect, StyleSwatch } from './catalog/types';
import { DASH_ARRAY } from './catalog/shapeKit';
import { stopNativeEvents } from '../plot/geometry';
import { STYLE_WIDTHS, type Annotation, type AnnotationWidth, type StylePatch } from './model';

export interface StylePanelProps {
  /** The selected drawing. */
  annotation: Annotation;
  /** Where the chip sits (wrapper-local px, its top-left). */
  at: [number, number];
  /** The plot area the chip and panel stay inside (wrapper-local px). */
  bounds: GridRect;
  theme: DrawingTheme;
  /** The plotted curves' colours. */
  swatches: readonly StyleSwatch[];
  onStyle: (patch: StylePatch) => void;
}

/** The chip's size, in CSS pixels. */
export const STYLE_CHIP = 20;
const PANEL_W = 196;
const PANEL_H = 112;
const GAP = 4;

const stopPanelEvents = stopNativeEvents('pointerdown', 'mousedown', 'dblclick', 'wheel');

const chipStyle = (left: number, top: number, open: boolean): CSSProperties => ({
  position: 'absolute',
  left,
  top,
  width: STYLE_CHIP,
  height: STYLE_CHIP,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  margin: 0,
  border: '1px solid var(--cds-border-subtle)',
  borderRadius: '50%',
  background: open ? 'var(--cds-layer-selected)' : 'var(--cds-layer)',
  boxShadow: '0 1px 2px var(--cds-shadow, transparent)',
  cursor: 'pointer',
  zIndex: 3,
});

const panelStyle = (left: number, top: number): CSSProperties => ({
  position: 'absolute',
  left,
  top,
  width: PANEL_W,
  boxSizing: 'border-box',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  border: '1px solid var(--cds-border-subtle)',
  borderRadius: 6,
  background: 'var(--cds-layer)',
  color: 'var(--cds-text-primary)',
  boxShadow: '0 4px 12px var(--cds-shadow, transparent)',
  zIndex: 3,
});

const ROW_LABEL: CSSProperties = {
  fontSize: 11,
  color: 'var(--cds-text-secondary)',
  marginBottom: 4,
};

const swatchStyle = (paint: string, on: boolean): CSSProperties => ({
  width: 16,
  height: 16,
  padding: 0,
  margin: 0,
  borderRadius: '50%',
  border: 'none',
  background: paint,
  boxShadow: on
    ? '0 0 0 2px var(--cds-layer), 0 0 0 3.5px var(--cds-border-interactive)'
    : 'inset 0 0 0 1px var(--cds-border-subtle)',
  cursor: 'pointer',
});

const sampleStyle = (on: boolean): CSSProperties => ({
  width: 28,
  height: 20,
  padding: 0,
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: 3,
  background: on ? 'var(--cds-layer-selected)' : 'transparent',
  boxShadow: on ? 'inset 0 0 0 1px var(--cds-border-interactive)' : 'none',
  color: 'var(--cds-icon-primary, var(--cds-text-primary))',
  cursor: 'pointer',
});

/** A line sample at `width`, solid or dashed, in the current colour. */
function LineSample({ width, dash }: { width: number; dash?: boolean }) {
  return (
    <svg width={20} height={10} viewBox="0 0 20 10" aria-hidden="true">
      <line
        x1={1}
        x2={19}
        y1={5}
        y2={5}
        stroke="currentColor"
        strokeWidth={width}
        strokeDasharray={dash ? DASH_ARRAY : undefined}
      />
    </svg>
  );
}

/** The chip, and the panel while it is open. Keyed by drawing id, so it closes on a new selection. */
export function StylePanel({
  annotation: a,
  at,
  bounds,
  theme,
  swatches,
  onStyle,
}: StylePanelProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const cx = Math.max(bounds.left, Math.min(at[0], right - STYLE_CHIP));
  const cy = Math.max(bounds.top, Math.min(at[1], bottom - STYLE_CHIP));
  // The panel opens below the chip, or above it when it would leave the plot,
  // and left-aligned with it, or right-aligned when it would.
  const px = cx + PANEL_W <= right ? cx : Math.max(bounds.left, cx + STYLE_CHIP - PANEL_W);
  const py =
    cy + STYLE_CHIP + GAP + PANEL_H <= bottom
      ? cy + STYLE_CHIP + GAP
      : Math.max(bounds.top, cy - GAP - PANEL_H);
  const row = swatchRow(theme, swatches);
  const paintNow = a.color === ANNOTATION_INK ? theme.annotation.ink : a.color;
  return (
    <div ref={stopPanelEvents} data-drawing-style="">
      <button
        type="button"
        aria-label="Style"
        aria-expanded={open}
        title="Style: colour and line"
        data-style-chip=""
        style={chipStyle(cx, cy, open)}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
          <circle cx={6} cy={6} r={4.5} fill={paintNow} />
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Drawing style"
          style={panelStyle(px, py)}
          data-style-panel=""
        >
          <div>
            <div style={ROW_LABEL}>Colour</div>
            <div
              role="radiogroup"
              aria-label="Colour"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
            >
              {row.map((s) => (
                <button
                  key={s.color}
                  type="button"
                  role="radio"
                  aria-checked={a.color === s.color}
                  aria-label={s.name}
                  title={s.name}
                  data-style-swatch={s.color}
                  style={swatchStyle(s.paint, a.color === s.color)}
                  onClick={() => onStyle({ color: s.color })}
                />
              ))}
            </div>
          </div>
          <div>
            <div style={ROW_LABEL}>Line</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <div role="radiogroup" aria-label="Line width" style={{ display: 'flex', gap: 2 }}>
                {STYLE_WIDTHS.map((w: AnnotationWidth) => (
                  <button
                    key={w}
                    type="button"
                    role="radio"
                    aria-checked={a.width === w}
                    aria-label={`${w} px`}
                    title={`${w} px`}
                    data-style-width={w}
                    style={sampleStyle(a.width === w)}
                    onClick={() => onStyle({ width: w })}
                  >
                    <LineSample width={w} />
                  </button>
                ))}
              </div>
              <span
                aria-hidden="true"
                style={{
                  width: 1,
                  height: 16,
                  margin: '0 4px',
                  background: 'var(--cds-border-subtle)',
                }}
              />
              <button
                type="button"
                aria-label="Dashed"
                aria-pressed={a.dash === true}
                title="Dashed"
                data-style-dash=""
                style={sampleStyle(a.dash === true)}
                onClick={() => onStyle({ dash: a.dash !== true })}
              >
                <LineSample width={1} dash />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
