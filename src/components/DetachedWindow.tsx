import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CARBON_THEME, useColorMode, type ColorMode } from '@slaclab/canopy-shell';

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

// Mirror the colour mode onto the popup's <html>, as canopy-shell's
// syncDocumentColorMode does for the opener's: `data-theme` for plain CSS, and
// the Carbon class (cds--g10/cds--g100), which gives the popup page its
// background and native color-scheme (scrollbars, form controls). The content
// inside the popup takes its tokens from the ColorModeTheme wrapper the parent
// renders around it. syncDocumentColorMode only writes to the global document,
// hence this copy; DetachedWindow.test.tsx fails if the two drift apart.
function syncPopupTheme(doc: Document, mode: ColorMode): void {
  const html = doc.documentElement;
  html.dataset.theme = mode;
  html.classList.remove('cds--white', 'cds--g10', 'cds--g90', 'cds--g100');
  html.classList.add(`cds--${CARBON_THEME[mode]}`);
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
  const { colorMode } = useColorMode();

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

    const mount = popup.document.createElement('div');
    mount.style.height = '100vh';
    popup.document.body.appendChild(mount);
    winRef.current = popup;

    let cancelled = false;
    cloneStyles(popup.document).then(() => {
      // The user may have closed the popup or reattached before stylesheets
      // resolved — don't mount into a torn-down window.
      if (cancelled) return;
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

  // Theme the popup's page, and keep it following the colour mode after it
  // opens. Declared after the open effect, so the popup exists on the first run.
  useEffect(() => {
    const popup = winRef.current;
    if (popup) syncPopupTheme(popup.document, colorMode);
  }, [colorMode]);

  // Keep the OS window title in sync with the plot title.
  useEffect(() => {
    const popup = winRef.current;
    if (popup) popup.document.title = title;
  }, [title]);

  if (!container) return null;
  return createPortal(children, container);
}
