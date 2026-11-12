// The in-place editor of a note's text, an <input> over the note's callout.
//
// No colour literals here (src/annotations is literal-guarded): its colours
// come from the chart theme and the drawing's stored colour.
import { useEffect, useRef } from 'react';
import { annotationPaint } from '../annotationTheme';
import type { GridProjection } from '../plot/geometry';
import { noteCallout } from './catalog/shapeKit';
import type { DrawingTheme } from './catalog/types';
import { MAX_ANNOTATION_TEXT, type Annotation } from './model';

export interface NoteEditorProps {
  a: Annotation;
  text: string;
  /** The grid the drawing renders in. */
  grid: GridProjection;
  theme: DrawingTheme;
  onChange: (text: string) => void;
  onFinish: (save: boolean) => void;
}

/**
 * The note's text typed in place: an <input> over the callout box, sized like
 * it and growing with the text. Enter or leaving the field saves, Escape
 * cancels. It is a sibling of the svgs (never part of the PNG capture), and
 * keeps its keys and presses to itself so no drawing or chart shortcut fires
 * while typing.
 */
export function NoteEditor({ a, text, grid, theme, onChange, onFinish }: NoteEditorProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const x = grid.tToX(a.points[0].t);
  const y = grid.vToY(a.points[0].v, a.axisId);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { bx, by, w, h } = noteCallout(x, y, text, grid.gridRect.left + grid.gridRect.width);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onFinish(save);
  };
  return (
    <input
      ref={ref}
      data-annotation-editor=""
      aria-label="Note text"
      value={text}
      maxLength={MAX_ANNOTATION_TEXT}
      placeholder="Note"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: bx,
        top: by,
        width: w,
        height: h,
        boxSizing: 'border-box',
        padding: '0 5px',
        margin: 0,
        border: '1px solid var(--cds-border-subtle)',
        borderRadius: 2,
        background: theme.bg,
        color: annotationPaint(a.color, theme.annotation),
        ...theme.annotation.label,
        outline: 'none',
        zIndex: 2,
      }}
    />
  );
}
