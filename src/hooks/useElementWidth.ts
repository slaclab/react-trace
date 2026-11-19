import { useCallback, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';

/**
 * The width of an element, followed with a ResizeObserver (0 where there is
 * none, as in jsdom). Attach `ref` to the element; `elRef` holds the same
 * element for readers that need a ref object.
 */
export function useElementWidth(): [Ref<HTMLDivElement>, number, RefObject<HTMLDivElement | null>] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    observer.current?.disconnect();
    observer.current = null;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, width, elRef];
}
