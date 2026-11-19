// A measure drawing's readout: its rows as small figure text beside the box,
// with the grip that drags it. The layer renders one per measure drawing.
//
// No colour literals here (src/annotations is literal-guarded).
import { useSyncExternalStore } from 'react';
import type { GridRect } from '../plot/geometry';
import { CARD_LINE, GRIP_W, LEADER_WIDTH, labelProps, readoutPlacement } from './catalog/shapeKit';
import type { DrawingTheme, DrawingTool, FrameStore, MeasureCardContext } from './catalog/types';
import type { Annotation } from './model';

/** What a drawing's measure readout reads (tools with a `card`). */
export interface CardSource {
  ctx: MeasureCardContext;
  frames: FrameStore;
  /** The readout's drag offset from its default place. */
  offset?: readonly [number, number];
}

/**
 * The measure readout: its rows as small figure text on a halo,
 * above and right of the box with a thin leader line (`readoutPlacement`),
 * never a card. Its rows come from the tool's `card` and the host's measure
 * provider; it subscribes to the host's frame store itself, so a new data
 * frame re-renders only the readout. While the measure is selected a
 * grip (⋮⋮) left of the text drags it; a double-click on the grip puts it
 * back. The grip is left out of the PNG capture.
 */
export function MeasureReadout({
  a,
  def,
  source,
  handles,
  grid,
  theme,
  grip,
}: {
  a: Annotation;
  def: DrawingTool;
  source: CardSource;
  handles: [number, number][];
  grid: GridRect;
  theme: DrawingTheme;
  grip: boolean;
}) {
  const { frames } = source;
  useSyncExternalStore(frames.subscribe, frames.getVersion, frames.getVersion);
  const lines = def.card?.(a, source.ctx) ?? [];
  if (lines.length === 0) return null;
  const at = readoutPlacement(lines, handles, grid, source.offset);
  const text = labelProps(theme, a.color);
  return (
    <g pointerEvents="none" data-measure-card="">
      {at.leader && (
        <path
          d={`M${at.leader[0]} ${at.leader[1]}L${at.leader[2]} ${at.leader[3]}`}
          stroke={a.color}
          strokeWidth={LEADER_WIDTH}
          fill="none"
        />
      )}
      {lines.map((line, i) => (
        <text key={i} x={at.x} y={at.y + (i + 1) * CARD_LINE - 3} {...text}>
          {line}
        </text>
      ))}
      {grip && (
        <g
          data-readout-grip=""
          data-capture-skip=""
          pointerEvents="all"
          style={{ cursor: 'grab' }}
          transform={`translate(${at.x - GRIP_W} ${at.y})`}
        >
          <rect width={GRIP_W - 2} height={at.h} fill="transparent" />
          {[0, 1, 2].flatMap((r) =>
            [0, 1].map((c) => (
              <circle
                key={`${r}${c}`}
                cx={2 + c * 3}
                cy={at.h / 2 - 3 + r * 3}
                r={0.9}
                fill={a.color}
                fillOpacity={0.6}
              />
            ))
          )}
        </g>
      )}
    </g>
  );
}
