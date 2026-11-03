import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { applyHostSheetFallback } from '@slaclab/canopy-shell';

interface DetachedWindowProps {
  /** Stable window name; reused so re-opening targets the same browsing context. */
  name: string;
  /** Document/tab title for the detached window. */
  title: string;
  width?: number;
  height?: number;
  /**
   * Called when the window should be considered closed — either the user
   * closed it from the OS chrome, or the browser blocked the popup. The parent
   * uses this to reattach the plot.
   */
  onClose: () => void;
  /** Called just before onClose when the browser blocked the popup, so the parent can say why. */
  onBlocked?: () => void;
  children: React.ReactNode;
}

// Clone the host document's stylesheets into the popup so Carbon components and
// our own CSS render identically. Covers both dev (<style> injected by Vite)
// and prod (<link rel="stylesheet">). Returns a promise that resolves once the
// cloned <link> stylesheets have loaded — mounting the portal before then lets
// ECharts measure against an unstyled container, causing a slow re-layout.
function cloneStyles(dest: Document): Promise<void> {
  const linkLoads: Promise<void>[] = [];
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    if (clone.tagName === 'LINK') {
      linkLoads.push(
        new Promise<void>((resolve) => {
          const done = () => resolve();
          clone.addEventListener('load', done, { once: true });
          clone.addEventListener('error', done, { once: true });
        })
      );
    }
    dest.head.appendChild(clone);
  });
  return Promise.all(linkLoads).then(() => undefined);
}

/**
 * Renders `children` into a separate browser window via a React portal. State,
 * context, and the data stores are shared with the opener, so live/archive
 * updates keep flowing and "reattach" is just unmounting this component.
 */
export function DetachedWindow({
  name,
  title,
  width = 960,
  height = 640,
  onClose,
  onBlocked,
  children,
}: DetachedWindowProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const winRef = useRef<Window | null>(null);

  useEffect(() => {
    const popup = window.open('', name, `popup=yes,width=${width},height=${height}`);
    if (!popup) {
      // Popup blocked — fall back to reattaching so the plot isn't lost.
      console.warn('[DetachedWindow] popup blocked by the browser; reattaching plot.');
      onBlocked?.();
      onClose();
      return;
    }
    popup.document.title = title;
    popup.document.body.style.margin = '0';
    popup.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'dark';
    // Also the Carbon theme class (cds--g10/cds--g100) the color-mode store puts
    // on <html>, so Carbon content portaled inside the popup gets the right tokens.
    const carbonTheme = Array.from(document.documentElement.classList).find((c) =>
      /^cds--(white|g10|g90|g100)$/.test(c)
    );
    if (carbonTheme) popup.document.documentElement.classList.add(carbonTheme);
    // A hosted opener hands its marker on; one that already fell back to the
    // standalone theme (its host stylesheet did not load) has none to hand on.
    const hostMarker = document.documentElement.dataset.canopyHost;
    if (hostMarker !== undefined) popup.document.documentElement.dataset.canopyHost = hostMarker;
    // The body lies outside every theme zone, and its colour shows until the
    // cloned stylesheets load: start from the opener's.
    popup.document.body.style.background = getComputedStyle(document.body).backgroundColor;

    const mount = popup.document.createElement('div');
    mount.style.height = '100vh';
    popup.document.body.appendChild(mount);
    winRef.current = popup;

    let cancelled = false;
    cloneStyles(popup.document).then(() => {
      // The user may have closed the popup or reattached before stylesheets
      // resolved — don't mount into a torn-down window.
      if (cancelled) return;
      // A host stylesheet that did not load in this window drops the marker
      // here, before the root mounts and reads the host contract.
      applyHostSheetFallback(popup.document);
      setContainer(mount);
    });

    // The user closing the OS window reattaches the plot. We remove this
    // listener before our own cleanup-driven close() so a parent-initiated
    // reattach doesn't re-fire onClose.
    const handleUnload = () => onClose();
    popup.addEventListener('pagehide', handleUnload);

    return () => {
      cancelled = true;
      popup.removeEventListener('pagehide', handleUnload);
      winRef.current = null;
      popup.close();
    };
    // Open exactly once per mount; `name` identifies the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the OS window title in sync with the plot title.
  useEffect(() => {
    const popup = winRef.current;
    if (popup) popup.document.title = title;
  }, [title]);

  if (!container) return null;
  return createPortal(children, container);
}
