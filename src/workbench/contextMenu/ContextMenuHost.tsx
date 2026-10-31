// The menu host: one per tool, mounted by the WorkbenchLayout. It holds the
// one open right-click menu, the "Copied …" toast and the PV info dialog, and
// resolves every menu from the registry (registry.ts) over three layers of
// writers, later layers winning:
//
//   1. schema — the layout's, derived from each item's own fields (Hide from
//      its eye, Move to axis from its Plot on, Inspect data, Create formula,
//      Remove from the binding's ops), so every tool has them for free;
//   2. tool   — what the tool registers from its canvas with
//      `useContextMenuWriters` (the PV of a row, copy value / shot, the
//      reference, Use as X, Open in, PV info…);
//   3. local  — what one opening passes (a plot's reading, Reset zoom, Copy
//      plot as image, Add note here).
//
// Callers open a menu with `useContextMenu()`: `openSignals(ids, at)` for a
// Properties row or a legend entry, `open(request, at, local)` for a point. Both
// return false when nothing applies, so the caller leaves the native menu.
//
// The menu is a plain Carbon `Menu` (focus, arrows, Esc, outside click and
// close-on-select come from Carbon), with the header line as its first,
// non-focusable entry. ⌘C / Ctrl+C while it is open runs Copy PV name.
// Copies confirm with a toast at the bottom of the tool for two seconds.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  InlineLoading,
  Menu,
  MenuItem,
  MenuItemDivider,
  MenuItemSelectable,
  Modal,
} from '@carbon/react';
import {
  copyPvItem,
  resolveMenu,
  type ContextMenuWriters,
  type InfoRow,
  type MenuEnv,
  type MenuItemModel,
  type MenuModel,
  type MenuRequest,
  type MenuSignal,
} from './registry';
import { copyPng, copyText } from './bridges';
import {
  MenuContext,
  WritersContext,
  type ContextMenuApi,
  type MenuAt,
  type WritersSlot,
} from './context';

/** How long a toast stays. */
export const TOAST_MS = 2000;

interface OpenMenu {
  model: MenuModel;
  at: MenuAt;
}

interface Info {
  signal: MenuSignal;
  rows: InfoRow[] | null;
  error: string | null;
}

function renderItem(item: MenuItemModel): ReactNode {
  if (item.children) {
    return (
      <MenuItem key={item.id} label={item.label} data-menu-item={item.id}>
        {item.children.map(renderItem)}
      </MenuItem>
    );
  }
  if (item.selected !== undefined) {
    return (
      <MenuItemSelectable
        key={item.id}
        label={item.label}
        selected={item.selected}
        disabled={item.disabled ? true : undefined}
        onChange={() => item.run?.()}
        data-menu-item={item.id}
      />
    );
  }
  return (
    <MenuItem
      key={item.id}
      label={item.label}
      shortcut={item.shortcut}
      kind={item.danger ? 'danger' : 'default'}
      disabled={item.disabled ? true : undefined}
      title={item.disabled || undefined}
      onClick={() => item.run?.()}
      data-menu-item={item.id}
    />
  );
}

/** Copy-shortcut: primary+C with no other modifier. */
function isCopyKey(e: KeyboardEvent): boolean {
  if (e.shiftKey || e.altKey) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  return e.key.toLowerCase() === 'c' || e.code === 'KeyC';
}

export interface ContextMenuProviderProps {
  /** The writers derived from the tool's schema (the layout's). */
  schemaWriters: ContextMenuWriters;
  children?: ReactNode;
}

export function ContextMenuProvider({ schemaWriters, children }: ContextMenuProviderProps) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [toastState, setToast] = useState<{ text: string; error: boolean; n: number } | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  // The menus portal here, inside the tool's themed tree, so the theme's
  // variables reach them; a menu opened in another window (a popped-out
  // plot) portals into that window's body.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const tool = useRef<ContextMenuWriters>({});
  const [slot] = useState<WritersSlot>(() => ({
    set: (w) => {
      tool.current = w;
    },
  }));
  const schema = useRef(schemaWriters);
  useLayoutEffect(() => {
    schema.current = schemaWriters;
  });

  const toast = useCallback((text: string, error = false) => {
    setToast((prev) => ({ text, error, n: (prev?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (toastState === null) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toastState]);

  const env = useMemo<MenuEnv>(
    () => ({
      copyText: (text, what) => {
        void copyText(text).then((ok) =>
          toast(ok ? `Copied ${what}` : 'Could not copy to the clipboard', !ok)
        );
      },
      copyImage: (make) => {
        void copyPng(make()).then((ok) =>
          toast(ok ? 'Copied plot image' : 'This browser cannot copy images here', !ok)
        );
      },
      showPvInfo: (signal, rows) => {
        setInfo({ signal, rows: null, error: null });
        rows.then(
          (r) => setInfo((cur) => (cur?.signal === signal ? { ...cur, rows: r } : cur)),
          (e: unknown) =>
            setInfo((cur) =>
              cur?.signal === signal
                ? { ...cur, rows: [], error: e instanceof Error ? e.message : String(e) }
                : cur
            )
        );
      },
    }),
    [toast]
  );

  const writers = useCallback(
    (local?: ContextMenuWriters): ContextMenuWriters => ({
      ...schema.current,
      ...tool.current,
      ...local,
    }),
    []
  );

  const signalOf = useCallback(
    (id: string): MenuSignal | null => writers().signalOf?.(id) ?? null,
    [writers]
  );

  const open = useCallback(
    (request: MenuRequest, at: MenuAt, local?: ContextMenuWriters): boolean => {
      const model = resolveMenu(request, writers(local), env);
      setMenu(model ? { model, at } : null);
      return model !== null;
    },
    [env, writers]
  );

  const openSignals = useCallback(
    (ids: readonly string[], at: MenuAt): boolean => {
      const signals = ids.map(signalOf).filter((s): s is MenuSignal => s !== null);
      if (signals.length === 0) return false;
      return open({ scope: 'signal', signals }, at);
    },
    [open, signalOf]
  );

  const api = useMemo<ContextMenuApi>(
    () => ({ open, openSignals, signalOf, toast }),
    [open, openSignals, signalOf, toast]
  );

  const close = () => setMenu(null);
  const opener = menu?.at.target;
  const target =
    layer !== null && (opener === undefined || opener.ownerDocument === layer.ownerDocument)
      ? layer
      : (opener ?? globalThis.document.body);
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (menu === null || !isCopyKey(e)) return;
    const item = copyPvItem(menu.model);
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    item.run?.();
    close();
  };

  return (
    <WritersContext.Provider value={slot}>
      <MenuContext.Provider value={api}>
        {children}
        <div ref={setLayer} className="wb-context-layer" />
        {menu && (
          <Menu
            label="Context menu"
            open
            target={target}
            x={menu.at.x}
            y={menu.at.y}
            size="sm"
            onClose={close}
            onKeyDownCapture={onKeyDownCapture}
            className="wb-context-menu"
            data-plot-menu="context"
          >
            {menu.model.header !== '' && (
              <li className="wb-context-menu__header" role="presentation" title={menu.model.header}>
                {menu.model.header}
              </li>
            )}
            {menu.model.groups.flatMap((group, i) => [
              ...(i > 0 ? [<MenuItemDivider key={`divider-${i}`} />] : []),
              ...group.map(renderItem),
            ])}
          </Menu>
        )}
        {toastState && (
          <div
            key={toastState.n}
            className={`wb-context-toast${toastState.error ? ' wb-context-toast--error' : ''}`}
            role="status"
            aria-live="polite"
          >
            <span className="wb-context-toast__mark" aria-hidden="true">
              {toastState.error ? '!' : '✓'}
            </span>
            <span className="wb-context-toast__text">{toastState.text}</span>
          </div>
        )}
        {info && (
          <Modal
            open
            passiveModal
            size="sm"
            modalLabel="PV info"
            modalHeading={info.signal.pv}
            onRequestClose={() => setInfo(null)}
            className="wb-pv-info"
          >
            {info.rows === null ? (
              <InlineLoading description="Reading the channel…" />
            ) : (
              <dl className="wb-pv-info__list">
                {info.rows.map((row) => (
                  <div key={row.label} className="wb-pv-info__row">
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
                {info.error && (
                  <div className="wb-pv-info__row">
                    <dt>Archiver</dt>
                    <dd>{info.error}</dd>
                  </div>
                )}
              </dl>
            )}
          </Modal>
        )}
      </MenuContext.Provider>
    </WritersContext.Provider>
  );
}
