// Shape helpers shared by the drawing tools' geometry and the note editor
//. Plain `.ts` with `createElement`, so the module exports no component
// and react-refresh stays clean.
//
// The look is a printed figure's (LaTeX / TikZ): fine strokes in the drawing's
// colour (the theme's ink by default), a fine dash, no fills but a faint tint
// on a range, small handles, and labels set in the theme's small serif italic
// on a halo of the plot's own colour instead of a card.
import { createElement, type ReactNode } from 'react';
import type { Annotation } from '../model';
import type { DrawingTheme } from './types';

/** Opacity of the drawing being placed. */
export const DRAFT_OPACITY = 0.8;
/** Width of the transparent stroke hit targets, in CSS pixels. */
export const HIT_WIDTH = 12;
/** Handle radius, in CSS pixels. */
export const HANDLE_R = 2.5;
/** Stroke width of a handle's ring. */
export const HANDLE_STROKE = 1;
/** Extra width of the selection halo over the drawing's stroke. */
export const OUTLINE_EXTRA = 3;
/** Opacity of the selection halo. */
export const OUTLINE_OPACITY = 0.22;
/** Trend extension length factor (pixels per unit segment length), as the sandbox. */
export const EXTEND_PX = 5000;
/** Font size of drawing labels, note text and the measure readout (the theme's label size). */
export const LABEL_SIZE = 11;
/** Dash pattern of a dashed drawing. */
export const DASH_ARRAY = '2 2';
/** Fill opacity of a range's band; no other drawing is filled. */
export const RANGE_FILL = 0.05;
/** Width of the halo stroked behind label text, in the plot's colour. */
export const HALO_WIDTH = 3;
/** Width of a leader line from a note's anchor, or a readout's box, to its text. */
export const LEADER_WIDTH = 0.6;
/** Radius of a note's anchor dot. */
export const ANCHOR_R = 1.5;

/** Readout line height. */
export const CARD_LINE = 14;
/** Rough glyph advance of the label serif at LABEL_SIZE (no text metrics in an svg we compose for capture). */
export const CARD_CHAR_W = 5.6;
/** Gap between the measured box and its readout. */
export const CARD_GAP = 14;

/** The svg path of an axis-aligned rectangle. */
export const rectPath = (x: number, y: number, w: number, h: number) =>
  `M${x} ${y}H${x + w}V${y + h}H${x}Z`;

/** True when every number is finite. */
export function finite(...ns: number[]): boolean {
  return ns.every((n) => Number.isFinite(n));
}

/** The stroke props of a drawing's marks: its colour, width and dash; no fill, no pointer events. */
export function strokeOf(a: Pick<Annotation, 'color' | 'width' | 'dash'>) {
  return {
    stroke: a.color,
    strokeWidth: a.width,
    strokeDasharray: a.dash ? DASH_ARRAY : undefined,
    fill: 'none',
    pointerEvents: 'none' as const,
  };
}

/** A transparent stroke hit target along path `d`. */
export function hitPath(d: string, key: string): ReactNode {
  return createElement('path', {
    key,
    d,
    fill: 'none',
    stroke: 'transparent',
    strokeWidth: HIT_WIDTH,
    pointerEvents: 'stroke',
    'data-annotation-hit': '',
  });
}

/** A transparent filled hit target over a rectangle (negative sizes clamp to 0). */
export function hitRect(x: number, y: number, w: number, h: number, key: string): ReactNode {
  return createElement('rect', {
    key,
    x,
    y,
    width: Math.max(0, w),
    height: Math.max(0, h),
    fill: 'transparent',
    pointerEvents: 'fill',
    'data-annotation-hit': '',
  });
}

/** The svg text props of a label: the theme's font on a halo of the plot's colour. */
export function labelProps(theme: DrawingTheme, color: string) {
  return {
    fill: color,
    ...theme.annotation.label,
    stroke: theme.bg,
    strokeWidth: HALO_WIDTH,
    strokeLinejoin: 'round' as const,
    paintOrder: 'stroke',
    pointerEvents: 'none' as const,
    'data-annotation-label': '',
  };
}

/** A drawing's text label at (`x`, `y`), or null when there is no text. */
export function label(
  theme: DrawingTheme,
  x: number,
  y: number,
  text: string,
  color: string,
  anchor: 'start' | 'middle' | 'end' = 'start'
): ReactNode {
  if (!text) return null;
  return createElement('text', { x, y, textAnchor: anchor, ...labelProps(theme, color) }, text);
}

/**
 * A note's text box (wrapper-local px) for anchor (`x`, `y`) and body `text`:
 * 14 px right of the anchor and 30 px up, flipped left when it would cross
 * the grid's right edge. The text sits on the box's baseline; the inline
 * editor and the note's hit target cover the box.
 */
export function noteCallout(
  x: number,
  y: number,
  text: string,
  right: number
): { bx: number; by: number; w: number; h: number } {
  const w = Math.max(40, (text || '').length * CARD_CHAR_W + 8);
  const flip = x + 14 + w > right;
  return { bx: flip ? x - 14 - w : x + 14, by: y - 30, w, h: 20 };
}

/** Where a measure readout's text block sits, and its leader line (wrapper-local px). */
export interface ReadoutPlacement {
  /** The block's left edge and top. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** From the box corner nearest the block to the block's nearest point; null when they touch. */
  leader: [number, number, number, number] | null;
}

/** Room left of a readout block for its grip. */
export const GRIP_W = 10;

/**
 * The readout block of `lines` beside the measure box spanned by `handles`:
 * above and to the right of the box, like a figure annotation, or left of it
 * when it would cross the grid's right edge; then moved by `offset` (a drag)
 * and kept inside the grid.
 */
export function readoutPlacement(
  lines: readonly string[],
  handles: readonly [number, number][],
  grid: { left: number; top: number; width: number; height: number },
  offset: readonly [number, number] = [0, 0]
): ReadoutPlacement {
  const xs = handles.map(([x]) => x);
  const ys = handles.map(([, y]) => y);
  const bx0 = Math.min(...xs);
  const bx1 = Math.max(...xs);
  const by0 = Math.min(...ys);
  const by1 = Math.max(...ys);
  const w = Math.ceil(Math.max(0, ...lines.map((l) => l.length)) * CARD_CHAR_W);
  const h = lines.length * CARD_LINE;
  const right = grid.left + grid.width;
  const bottom = grid.top + grid.height;
  let x = bx1 + CARD_GAP + w <= right ? bx1 + CARD_GAP : bx0 - CARD_GAP - w;
  let y = by0 - CARD_GAP - h;
  if (y < grid.top) y = by1 + CARD_GAP <= bottom - h ? by1 + CARD_GAP : grid.top;
  x = Math.max(grid.left + GRIP_W, Math.min(x + offset[0], right - w));
  y = Math.max(grid.top, Math.min(y + offset[1], bottom - h));
  // The leader: the block's point nearest the box's centre, and the box
  // corner nearest that point.
  const px = Math.max(x, Math.min((bx0 + bx1) / 2, x + w));
  const py = Math.max(y, Math.min((by0 + by1) / 2, y + h));
  const cx = Math.abs(px - bx0) < Math.abs(px - bx1) ? bx0 : bx1;
  const cy = Math.abs(py - by0) < Math.abs(py - by1) ? by0 : by1;
  const apart = x > bx1 || x + w < bx0 || y > by1 || y + h < by0;
  return { x, y, w, h, leader: apart ? [cx, cy, px, py] : null };
}
