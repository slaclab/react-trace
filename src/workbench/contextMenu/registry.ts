// The plot tools' right-click menus: ONE action registry every tool's menus
// are built from, so an action added here reaches Trace, Correlation
// and Waveform at once (the strip toggles' pattern, annotations/plotToggles).
//
// An action is declared once with the scopes it applies to:
//   - `signal`: a right-click on a Properties row or on a curve's legend entry;
//     the request names one signal, or several picked rows;
//   - `point`: a right-click in the plot area; the request names the curve
//     nearest the pointer (when there is one) and the reading under it.
// Which tools offer it follows from the writers: a tool wires the writers it
// can serve, and an action whose writer is not wired is left out. Nothing
// here names a tool.
//
// Items are grouped (copy, mark, route, data, view, share, item) and a
// divider stands between groups; within a group they keep registry order.
// With several signals only the `multi` actions are offered.
//
// Pure: `resolveMenu` reads the request and the writers and returns the
// menu's model; running an item calls the writer or the `MenuEnv` effects.

import { formatShortcut } from '../useCanvasActions';

/** Where a menu was opened: a signal (row or legend entry) or a point on the plot. */
export type MenuScope = 'signal' | 'point';

/** A plotted signal as the menus see it: its item id and full PV name. */
export interface MenuSignal {
  /** The tool's item id (an Outline row id). */
  id: string;
  /** The full channel name. */
  pv: string;
}

/** What a right-click asks for. */
export interface MenuRequest {
  scope: MenuScope;
  /** The row(s) or legend entry (signal); the curve nearest the pointer, if any (point). */
  signals: readonly MenuSignal[];
  /** The reading under the pointer (point): the header line and the copied text. */
  reading?: { header: string; text: string };
}

/** Something a writer offers to run, with its label when it differs from the action's own. */
export interface Offer {
  run(): void;
  label?: string;
  /** The reason it cannot run now; shown disabled. */
  disabled?: string | false;
}

/** Text a copy action puts on the clipboard. */
export interface CopyOffer {
  text: string;
  /** The item label, when it differs from the action's own. */
  label?: string;
  /** What the toast names: "Copied <what>"; the text itself when absent. */
  what?: string;
}

/** A choice of a submenu: a target tool, an axis. */
export interface Choice {
  label: string;
  run(): void;
  selected?: boolean;
  disabled?: string | false;
}

/** One row of the PV info dialog. */
export interface InfoRow {
  label: string;
  value: string;
}

/**
 * Everything a tool can serve. Each writer is optional: an action whose
 * writer is absent, or returns null, is left out of the menu.
 */
export interface ContextMenuWriters {
  /** The signal an item id names, or null when the item is not a signal (a drawing, a snapshot). */
  signalOf?(id: string): MenuSignal | null;
  /** Copy the signal's value at the plot cursor (or its latest). */
  copyValue?(s: MenuSignal): CopyOffer | null;
  /** Copy the shot's array: the signal's, or every drawn curve's when null. */
  copyShot?(s: MenuSignal | null): CopyOffer | null;
  /** Copy the fit's numbers; null while the fit is off. */
  copyFit?(s: MenuSignal | null): CopyOffer | null;
  /** Fill the reference with this signal. */
  useAsReference?(s: MenuSignal): Offer | null;
  /** Freeze the current shot as the reference. */
  snapshotReference?(): Offer | null;
  /** Hold the current shot on the plot without pausing (or let it go). */
  freezeShot?(): Offer | null;
  /** Put this signal on X. */
  useAsX?(s: MenuSignal): Offer | null;
  /** The other tools this signal opens in. */
  openIn?(s: MenuSignal): Choice[];
  /** Open the signal against another one of the plot. */
  correlateAgainst?(s: MenuSignal): Offer | null;
  /** What the tool knows of the channel. */
  pvInfo?(s: MenuSignal): Promise<InfoRow[]>;
  inspect?(s: MenuSignal): Offer | null;
  createFormula?(s: MenuSignal): Offer | null;
  /** The axes the signal can move to, the current one selected. */
  moveTo?(s: MenuSignal): Choice[] | null;
  /** The signal's visibility. */
  hide?(s: MenuSignal): { hidden: boolean; set(hidden: boolean): void } | null;
  remove?(s: MenuSignal): Offer | null;
  /** The drawings placed at the point ("Add note here"). */
  addHere?(): Choice[];
  resetZoom?(): Offer | null;
  /** The plot as a PNG, or null when it cannot be drawn now. */
  copyImage?(): (() => Promise<Blob | null>) | null;
  /** A link that reopens this tool with this view. */
  viewLink?(): string | null;
}

/** The effects the items run through, owned by the menu host. */
export interface MenuEnv {
  copyText(text: string, what: string): void;
  copyImage(make: () => Promise<Blob | null>): void;
  showPvInfo(s: MenuSignal, rows: Promise<InfoRow[]>): void;
}

/** One menu entry; `children` makes it a submenu. */
export interface MenuItemModel {
  /** The action id (a submenu choice: `<action>:<index>`). */
  id: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: string | false;
  selected?: boolean;
  run?(): void;
  children?: MenuItemModel[];
}

/** The resolved menu: its header line and its groups, a divider between groups. */
export interface MenuModel {
  header: string;
  groups: MenuItemModel[][];
}

export type MenuGroup = 'copy' | 'mark' | 'route' | 'data' | 'view' | 'share' | 'item';

/** The groups in menu order. */
export const MENU_GROUPS: readonly MenuGroup[] = [
  'copy',
  'mark',
  'route',
  'data',
  'view',
  'share',
  'item',
];

/** What an action's `resolve` reads. */
export interface ResolveInput {
  request: MenuRequest;
  /** The first signal of the request, or null. */
  signal: MenuSignal | null;
  w: ContextMenuWriters;
  env: MenuEnv;
}

/** One registry action. */
export interface ContextActionSpec {
  id: string;
  scopes: readonly MenuScope[];
  /** Its group. */
  group: MenuGroup;
  /** Offered with several signals (it acts on all of them). */
  multi?: boolean;
  /** The item (or items), or null when it does not apply. */
  resolve(input: ResolveInput): MenuItemModel | readonly MenuItemModel[] | null;
}

/** The ⌘C / Ctrl+C hint on Copy PV name; the host runs that item on the key. */
export const COPY_SHORTCUT = formatShortcut('primary+C');

const COPY_PV = 'copy-pv';

function offerItem(id: string, label: string, offer: Offer | null): MenuItemModel | null {
  if (offer === null) return null;
  return { id, label: offer.label ?? label, disabled: offer.disabled, run: () => offer.run() };
}

function copyItem(id: string, label: string, offer: CopyOffer | null, env: MenuEnv) {
  if (offer === null) return null;
  return {
    id,
    label: offer.label ?? label,
    run: () => env.copyText(offer.text, offer.what ?? offer.text),
  };
}

function choices(id: string, list: Choice[]): MenuItemModel[] {
  return list.map((c, i) => ({
    id: `${id}:${i}`,
    label: c.label,
    selected: c.selected,
    disabled: c.disabled,
    run: () => c.run(),
  }));
}

/** Every action, in menu order within its group. */
export const CONTEXT_ACTIONS: readonly ContextActionSpec[] = Object.freeze([
  {
    id: 'copy-reading',
    scopes: ['point'],
    group: 'copy',
    resolve: ({ request, env }) => {
      const r = request.reading;
      return r
        ? { id: 'copy-reading', label: 'Copy reading', run: () => env.copyText(r.text, r.text) }
        : null;
    },
  },
  {
    id: COPY_PV,
    scopes: ['signal', 'point'],
    group: 'copy',
    multi: true,
    resolve: ({ request, env }) => {
      const names = request.signals.map((s) => s.pv);
      if (names.length === 0) return null;
      const what = names.length === 1 ? names[0] : `${names.length} PV names`;
      return {
        id: COPY_PV,
        label: names.length === 1 ? 'Copy PV name' : 'Copy PV names',
        shortcut: COPY_SHORTCUT,
        run: () => env.copyText(names.join('\n'), what),
      };
    },
  },
  {
    id: 'copy-value',
    scopes: ['signal'],
    group: 'copy',
    resolve: ({ signal, w, env }) =>
      signal && w.copyValue
        ? copyItem('copy-value', 'Copy value at cursor', w.copyValue(signal), env)
        : null,
  },
  {
    id: 'copy-shot',
    scopes: ['signal', 'point'],
    group: 'copy',
    resolve: ({ request, signal, w, env }) =>
      w.copyShot
        ? copyItem(
            'copy-shot',
            'Copy this shot',
            w.copyShot(request.scope === 'signal' ? signal : null),
            env
          )
        : null,
  },
  {
    id: 'copy-fit',
    scopes: ['signal', 'point'],
    group: 'copy',
    resolve: ({ signal, w, env }) =>
      w.copyFit
        ? copyItem('copy-fit', 'Copy fit (slope, offset, R²)', w.copyFit(signal), env)
        : null,
  },
  {
    id: 'use-as-reference',
    scopes: ['signal'],
    group: 'mark',
    resolve: ({ signal, w }) =>
      signal && w.useAsReference
        ? offerItem('use-as-reference', 'Use as reference', w.useAsReference(signal))
        : null,
  },
  {
    id: 'snapshot-reference',
    scopes: ['signal', 'point'],
    group: 'mark',
    resolve: ({ request, w }) =>
      w.snapshotReference
        ? offerItem(
            'snapshot-reference',
            request.scope === 'signal'
              ? 'Take snapshot as reference'
              : 'Use this shot as reference',
            w.snapshotReference()
          )
        : null,
  },
  {
    id: 'freeze-shot',
    scopes: ['point'],
    group: 'mark',
    resolve: ({ w }) =>
      w.freezeShot ? offerItem('freeze-shot', 'Freeze this shot', w.freezeShot()) : null,
  },
  {
    id: 'add-here',
    scopes: ['point'],
    group: 'mark',
    // One item per drawing tool, not a submenu.
    resolve: ({ w }) => choices('add-here', w.addHere?.() ?? []),
  },
  {
    id: 'use-as-x',
    scopes: ['signal'],
    group: 'route',
    resolve: ({ signal, w }) =>
      signal && w.useAsX ? offerItem('use-as-x', 'Use as X', w.useAsX(signal)) : null,
  },
  {
    id: 'open-in',
    scopes: ['signal'],
    group: 'route',
    resolve: ({ signal, w }) => {
      const list = signal && w.openIn ? w.openIn(signal) : [];
      return list.length > 0
        ? { id: 'open-in', label: 'Open in', children: choices('open-in', list) }
        : null;
    },
  },
  {
    id: 'correlate-against',
    scopes: ['signal'],
    group: 'route',
    resolve: ({ signal, w }) =>
      signal && w.correlateAgainst
        ? offerItem('correlate-against', 'Correlate against …', w.correlateAgainst(signal))
        : null,
  },
  {
    id: 'pv-info',
    scopes: ['signal'],
    group: 'route',
    resolve: ({ signal, w, env }) => {
      const info = w.pvInfo;
      if (!signal || !info) return null;
      return { id: 'pv-info', label: 'PV info…', run: () => env.showPvInfo(signal, info(signal)) };
    },
  },
  {
    id: 'inspect-data',
    scopes: ['signal'],
    group: 'data',
    resolve: ({ signal, w }) =>
      signal && w.inspect ? offerItem('inspect-data', 'Inspect data', w.inspect(signal)) : null,
  },
  {
    id: 'create-formula',
    scopes: ['signal'],
    group: 'data',
    resolve: ({ signal, w }) =>
      signal && w.createFormula
        ? offerItem('create-formula', 'Create formula from this curve', w.createFormula(signal))
        : null,
  },
  {
    id: 'reset-zoom',
    scopes: ['point'],
    group: 'view',
    resolve: ({ w }) => (w.resetZoom ? offerItem('reset-zoom', 'Reset zoom', w.resetZoom()) : null),
  },
  {
    id: 'copy-image',
    scopes: ['point'],
    group: 'share',
    resolve: ({ w, env }) => {
      const make = w.copyImage?.() ?? null;
      return make
        ? { id: 'copy-image', label: 'Copy plot as image', run: () => env.copyImage(make) }
        : null;
    },
  },
  {
    id: 'copy-link',
    scopes: ['point'],
    group: 'share',
    resolve: ({ w, env }) => {
      const link = w.viewLink?.() ?? null;
      return link
        ? {
            id: 'copy-link',
            label: 'Copy link to this view',
            run: () => env.copyText(link, 'link'),
          }
        : null;
    },
  },
  {
    id: 'move-to-axis',
    scopes: ['signal'],
    group: 'item',
    resolve: ({ signal, w }) => {
      const list = signal && w.moveTo ? w.moveTo(signal) : null;
      return list && list.length > 0
        ? { id: 'move-to-axis', label: 'Move to axis', children: choices('move-to-axis', list) }
        : null;
    },
  },
  {
    id: 'hide',
    scopes: ['signal'],
    group: 'item',
    multi: true,
    resolve: ({ request, w }) => {
      const hide = w.hide;
      if (!hide) return null;
      const eyes = request.signals.map((s) => hide(s)).filter((e) => e !== null);
      if (eyes.length === 0) return null;
      // Hide while any is shown; Show once all are hidden.
      const show = eyes.every((e) => e.hidden);
      return {
        id: 'hide',
        label: show ? 'Show' : 'Hide',
        run: () => eyes.forEach((e) => e.set(!show)),
      };
    },
  },
  {
    id: 'remove',
    scopes: ['signal'],
    group: 'item',
    multi: true,
    resolve: ({ request, w }) => {
      const remove = w.remove;
      if (!remove) return null;
      const offers = request.signals.map((s) => remove(s)).filter((o) => o !== null);
      if (offers.length === 0) return null;
      return {
        id: 'remove',
        label: 'Remove',
        danger: true,
        run: () => offers.forEach((o) => o.run()),
      };
    },
  },
] satisfies ContextActionSpec[]);

/** The menu's header line: the full PV name, the count, or the reading. */
export function menuHeader(request: MenuRequest): string {
  if (request.scope === 'point') return request.reading?.header ?? request.signals[0]?.pv ?? '';
  const n = request.signals.length;
  return n === 1 ? request.signals[0].pv : `${n} signals`;
}

/** The menu for `request` over `w`, or null when nothing applies. */
export function resolveMenu(
  request: MenuRequest,
  w: ContextMenuWriters,
  env: MenuEnv,
  actions: readonly ContextActionSpec[] = CONTEXT_ACTIONS
): MenuModel | null {
  const multi = request.scope === 'signal' && request.signals.length > 1;
  const input: ResolveInput = { request, signal: request.signals[0] ?? null, w, env };
  const byGroup = new Map<MenuGroup, MenuItemModel[]>();
  for (const spec of actions) {
    if (!spec.scopes.includes(request.scope)) continue;
    if (multi && !spec.multi) continue;
    const group = spec.group;
    const resolved = spec.resolve(input);
    if (resolved === null) continue;
    const items = Array.isArray(resolved) ? resolved : [resolved as MenuItemModel];
    if (items.length > 0) byGroup.set(group, [...(byGroup.get(group) ?? []), ...items]);
  }
  const groups = MENU_GROUPS.flatMap((g) => (byGroup.has(g) ? [byGroup.get(g)!] : []));
  if (groups.length === 0) return null;
  return { header: menuHeader(request), groups };
}

/** The Copy PV name item of a resolved menu, the one ⌘C runs. */
export function copyPvItem(menu: MenuModel): MenuItemModel | undefined {
  for (const group of menu.groups) {
    const item = group.find((i) => i.id === COPY_PV);
    if (item) return item;
  }
  return undefined;
}
