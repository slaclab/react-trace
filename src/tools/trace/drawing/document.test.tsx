// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Annotation } from '../../../annotations/model';
import { DEFAULT_TOOL_PREFS } from '../../../annotations/tools';
import { traceDrawingDocument, useTraceDrawingDocument } from './document';

describe('traceDrawingDocument', () => {
  it('forwards every writer to the channel props, label included', () => {
    const p = {
      annotations: [] as Annotation[],
      onCommitAnnotations: vi.fn(),
      onSelectAnnotation: vi.fn(),
      onAnnotationPrefs: vi.fn(),
      onAnnotationsHidden: vi.fn(),
    };
    const doc = traceDrawingDocument(p);
    const fn = (l: Annotation[]) => l;
    doc.commit(fn, 'Draw V-line');
    expect(p.onCommitAnnotations).toHaveBeenCalledWith(fn, 'Draw V-line');
    doc.select('x');
    expect(p.onSelectAnnotation).toHaveBeenCalledWith('x');
    doc.setPrefs({ tool: 'vline' });
    expect(p.onAnnotationPrefs).toHaveBeenCalledWith({ tool: 'vline' });
    doc.setHidden?.(true);
    expect(p.onAnnotationsHidden).toHaveBeenCalledWith(true);
    expect(doc.annotations).toBe(p.annotations);
  });

  it('reads defaults and no-op writers when the props are absent', () => {
    const doc = traceDrawingDocument({});
    expect(doc.annotations).toEqual([]);
    expect(doc.selectedId).toBeNull();
    expect(doc.prefs).toBe(DEFAULT_TOOL_PREFS);
    expect(doc.hidden).toBe(false);
    // No hide-all writer: the strip offers no hide toggle.
    expect(doc.setHidden).toBeUndefined();
    expect(() => {
      doc.commit((l) => l, 'x');
      doc.select(null);
      doc.setPrefs({});
      doc.undo();
    }).not.toThrow();
    // The empty list is one stable object.
    expect(traceDrawingDocument({}).annotations).toBe(doc.annotations);
  });

  it('memoizes on the props', () => {
    const onCommitAnnotations = vi.fn();
    const { result, rerender } = renderHook((p) => useTraceDrawingDocument(p), {
      initialProps: { onCommitAnnotations, annotationsHidden: false },
    });
    const first = result.current;
    rerender({ onCommitAnnotations, annotationsHidden: false });
    expect(result.current).toBe(first);
    rerender({ onCommitAnnotations, annotationsHidden: true });
    expect(result.current).not.toBe(first);
    expect(result.current.hidden).toBe(true);
  });
});
