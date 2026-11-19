// The drawing undo key: one native keydown listener on the document this
// element renders into, so a plot in a detached window undoes there. It uses
// `isUndoKey`: primary+Z (Cmd on macOS, Ctrl elsewhere), never a claimed or
// shifted key and never inside text entry, so the browser undoes typing in an
// input, but a select or colour input still undoes the drawing. A consumed key
// has its default prevented.
import { useEffect, useRef } from 'react';
import { isUndoKey } from '../history';
import { IS_MAC } from '../../workbench/useCanvasActions';

export interface UndoKeyListenerProps {
  /** Undo the plot's newest drawing edit. */
  onUndo(): void;
  /** Bind Cmd (true) or Ctrl (false); defaults to the platform. */
  mac?: boolean;
}

export function UndoKeyListener({ onUndo, mac = IS_MAC }: UndoKeyListenerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  // The latest callback, so a new `onUndo` never rebinds the listener.
  const onUndoRef = useRef(onUndo);
  useEffect(() => {
    onUndoRef.current = onUndo;
  }, [onUndo]);
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isUndoKey(e, mac)) return;
      e.preventDefault();
      onUndoRef.current();
    };
    doc.addEventListener('keydown', onKeyDown);
    return () => doc.removeEventListener('keydown', onKeyDown);
  }, [mac]);
  return <span ref={ref} hidden />;
}
