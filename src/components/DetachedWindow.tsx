import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  children: React.ReactNode;
}

// Clone the host document's stylesheets into the popup so Carbon components and
// our own CSS render identically. Covers both dev (<style> injected by Vite)
// and prod (<link rel="stylesheet">).
function cloneStyles(dest: Document): void {
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    dest.head.appendChild(node.cloneNode(true));
  });
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
  children,
}: DetachedWindowProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const winRef = useRef<Window | null>(null);

  useEffect(() => {
    const popup = window.open('', name, `popup=yes,width=${width},height=${height}`);
    if (!popup) {
      // Popup blocked — fall back to reattaching so the plot isn't lost.
      console.warn('[DetachedWindow] popup blocked by the browser; reattaching plot.');
      onClose();
      return;
    }
    popup.document.title = title;
    popup.document.body.style.margin = '0';
    popup.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'dark';
    cloneStyles(popup.document);

    const mount = popup.document.createElement('div');
    mount.style.height = '100vh';
    popup.document.body.appendChild(mount);
    winRef.current = popup;
    // The portal target only exists after window.open, so it must be set from
    // this effect — there's no render-time value to derive it from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContainer(mount);

    // The user closing the OS window reattaches the plot. We remove this
    // listener before our own cleanup-driven close() so a parent-initiated
    // reattach doesn't re-fire onClose.
    const handleUnload = () => onClose();
    popup.addEventListener('pagehide', handleUnload);

    return () => {
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
