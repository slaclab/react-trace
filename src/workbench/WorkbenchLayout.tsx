// The workbench layout.
//
// One tool's whole surface: the actions bar on top, then the Sidebar (the
// properties panel: the top block of signals and the plot-wide sections)
// beside the canvas, which is this component's child slot. The layout provides the tool's selection to every part (the
// canvas reads it with `useWorkbenchSelection`) and its action registry to the
// canvas (`useCanvasActions`) and the actions bar. Styles: `workbench.css`, the
// one stylesheet entry, imported here.
//
// Rate rule. A tool re-renders the layout on every data tick
// and may rebuild its binding, capabilities and model objects each time. The
// layout reads the binding and the writer through a latest-ref (a stable
// definition and `update` that delegate to the newest ones), and hands the
// panel's two halves the model of the last tick that changed what they show:
// each tick it compares the outline view-model structurally (rows by id,
// kind, status, label, refusal) plus the value, gates and dot of every card
// slot, section field, footer action and the open card's fields (the top
// block), and of every tool-level field, summary and Axes-placed section field
// (the plot-wide sections). A tick that changes none of that renders neither
// half. A state write, a new `ui` record, changed capabilities or a new
// selection always renders both. The Sidebar is memoized too, so the canvas
// reaches its slot through a small store and a new canvas element renders the
// canvas alone.
//
// Root Escape, after every inner consumer (a React bubbling handler on the
// root): go to tool level (a reset, which reveals nothing) and move the focus
// to Properties only when that pane is visible. It does
// nothing when an inner consumer claimed the key (`defaultPrevented`, or a PV
// field's draft revert, which stops it), while a card drag runs, or when the key's target
// is inside a dialog or outside the sidebar and the plot surface — the actions
// bar, a portal.
//
// Quick open. Embedded, primary+K (Cmd on macOS, Ctrl
// elsewhere) anywhere in the tool's document posts
//   {type: 'canopy:quick-open'}
// to `window.parent`, same-origin (as `canopy:trace-open`), so the workspace
// opens its palette even while focus sits in this frame. A window keydown
// listener, like the action shortcuts; it skips keys typed into an editable
// field or already claimed by an inner consumer, and holds no state, so a key
// press renders nothing.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { ActionsBar } from './ActionsBar';
import { ContextMenuProvider } from './contextMenu/ContextMenuHost';
import { schemaMenuWriters } from './contextMenu/schemaWriters';
import type { ArrangementStore } from './arrangementStore';
import { fieldSignature, schemaFields } from './fields';
import { OpenMemoryProvider } from './FieldBlock';
import { OpenMemory } from './openMemory';
import { Outline } from './Outline';
import { PlotSettings } from './PlotSettings';
import {
  SelectionProvider,
  createSelectionStore,
  resolveSelection,
  type SelectionStore,
} from './selection';
import { Sidebar } from './Sidebar';
import { useToolActionsPublisher } from './toolActionsPublisher';
import { embeddedPage, hostBarPage } from './embedding';
import { useToolInvoke } from './toolInvoke';
import {
  CanvasActionsProvider,
  IS_MAC,
  createActionRegistry,
  isEditableTarget,
  useActionShortcuts,
  type ActionRegistry,
  type KeyEventLike,
} from './useCanvasActions';
import type {
  Action,
  Capabilities,
  OutlineViewModel,
  Selection,
  Target,
  ToolBinding,
  FieldDef,
  ToolContext,
  ToolDefinition,
  ToolUi,
} from './types';
import './workbench.css';

/** The message asking the embedding workspace to open its quick-open palette. */
export const QUICK_OPEN = 'canopy:quick-open';

export interface QuickOpenMessage {
  type: typeof QUICK_OPEN;
}

/** Primary+K, no Shift or Alt; the physical key wins over `key` (Option layouts). Pure. */
// eslint-disable-next-line react-refresh/only-export-components -- the binding is pinned by WorkbenchLayout.test.tsx on both platforms
export function isQuickOpenKey(e: KeyEventLike, mac: boolean = IS_MAC): boolean {
  if (e.shiftKey || e.altKey) return false;
  if (!(mac ? e.metaKey : e.ctrlKey)) return false;
  const fromCode =
    typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
  return (fromCode || e.key.toLowerCase()) === 'k';
}

/** Embedded only: primary+K posts {@link QUICK_OPEN} to the parent, same-origin. */
function useQuickOpenShortcut(): void {
  useEffect(() => {
    if (!embeddedPage()) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target) || !isQuickOpenKey(e)) return;
      e.preventDefault();
      const message: QuickOpenMessage = { type: QUICK_OPEN };
      window.parent.postMessage(message, window.location.origin);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

export interface WorkbenchLayoutProps<S, M, U extends ToolUi = ToolUi> {
  definition: ToolDefinition<S, M, U>;
  state: S;
  model: M;
  ui: U;
  /** The tool's single writer. */
  update(fn: (state: S) => S): void;
  capabilities: Capabilities;
  /** The tool's selection; the layout creates one when absent. */
  selection?: SelectionStore;
  /** The page's arrangement store; the Sidebar creates and connects one when absent. */
  arrangement?: ArrangementStore;
  /** The tool's action registry; the layout creates one when absent. */
  actions?: ActionRegistry;
  /** Channel catalog for the Outline's add rows. */
  catalog?: readonly string[];
  archiver?: string;
  /** The tool-level target's kind and id (`ctx.target` of the plot-wide fields). */
  toolId?: string;
  /** Under the host bar: the tool's one-line state for the host's tile bar (e.g. `live`, `paused`). */
  hostState?: string;
  /** The canvas (the plot surface). */
  children?: ReactNode;
}

const MemoOutline = memo(Outline) as typeof Outline;
const MemoPlotSettings = memo(PlotSettings) as typeof PlotSettings;
// Re-rendering the Sidebar re-renders the Outline's drag context, so it
// renders only when a half of the panel does.
const MemoSidebar = memo(Sidebar);

const DIALOG = '[role="dialog"], [role="alertdialog"], dialog';
/** A card drag marks its head; the root steps aside meanwhile. */
const ROW_DRAGGING = '.wb-outline-row--dragging';
const PROPERTIES_PANE = '.wb-sidebar__pane[data-pane="properties"]';

// ------------------------------------------------------- structural compare --

/** A comparable form: `text` by string equality, `refs` by identity. */
interface Signature {
  text: string;
  refs: unknown[];
}

function sameSignature(a: Signature | null, b: Signature): boolean {
  if (a === null || a.text !== b.text || a.refs.length !== b.refs.length) return false;
  return a.refs.every((ref, i) => Object.is(ref, b.refs[i]));
}

let opaque = 0;
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // A value that cannot be compared renders every time.
    opaque += 1;
    return `opaque:${opaque}`;
  }
}

/** The outline view-model: data by value, add-row searches by identity. */
function outlineSignature(outline: OutlineViewModel): Signature {
  const refs: unknown[] = [];
  const text = stringify([
    outline.sections.map((s) => {
      refs.push(s.add?.search);
      return [
        s.id,
        s.kind,
        s.title,
        s.unit,
        s.count,
        s.capacity,
        s.muted,
        s.add ? [s.add.placeholder, s.add.disabled] : null,
        s.rows.map((r) => [r.id, r.kind, r.status, r.label, r.refusal]),
      ];
    }),
  ]);
  return { text, refs };
}

function footerSignature(footer: readonly Action[] | undefined): Signature {
  const list = footer ?? [];
  return {
    text: stringify(list.map((a) => [a.id, a.label, a.kind, a.pressed, a.disabled, a.shortcut])),
    refs: list.map((a) => a.icon),
  };
}

function sameRecord(a: Capabilities, b: Capabilities): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

function targetKey(target: Target): string {
  return `${target.level}:${target.kind}:${target.id}`;
}

/** The selection key of "nothing selected" (the tool's own id does not matter here). */
const TOOL_TARGET: Target = { level: 'tool', kind: 'tool', id: 'tool' };

// ------------------------------------------------------------ latest source --

/**
 * The latest props, behind a stable definition and writer, and the model each
 * pane was last rendered with. `sync` runs once per layout render.
 */
class LayoutSource<S, M, U extends ToolUi> {
  private props!: WorkbenchLayoutProps<S, M, U>;
  private last: {
    state: S;
    ui: U;
    schema: ToolDefinition<S, M, U>['schema'];
  } | null = null;
  private rawSig: Signature | null = null;
  private outlineSig: Signature | null = null;
  private plotSig: Signature | null = null;

  /** The stabilized outline view-model (replaced only on a structural change). */
  outline!: OutlineViewModel;
  /** The model the top block / the plot-wide sections were last rendered with. */
  outlineModel!: M;
  plotModel!: M;
  capabilities!: Capabilities;
  catalog: readonly string[] | undefined;

  readonly update = (fn: (state: S) => S): void => this.props.update(fn);

  readonly definition: ToolDefinition<S, M, U>;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const source = this;
    const latest = () => source.props.definition.binding;
    const binding: ToolBinding<S, M> = {
      outline: (state, model) => latest().outline(state, model),
      ops: {
        add: (sectionId, pv) => latest().ops.add(sectionId, pv),
        remove: (itemId) => latest().ops.remove(itemId),
        move: (itemId, sectionId) => latest().ops.move(itemId, sectionId),
      },
      moveRefusal: (itemId, sectionId) => latest().moveRefusal(itemId, sectionId),
      get footer() {
        const footer = latest().footer;
        // Each click runs the newest action of that id.
        return footer?.map((action) => ({
          ...action,
          onClick: () =>
            latest()
              .footer?.find((a) => a.id === action.id)
              ?.onClick(),
        }));
      },
    };
    this.definition = {
      get schema() {
        return source.props.definition.schema;
      },
      binding,
    };
  }

  private ctx(target: Target, selection: Selection): ToolContext<S, M, U> {
    const { state, model, ui } = this.props;
    return {
      state,
      model,
      update: this.update,
      selection,
      target,
      capabilities: this.capabilities,
      ui,
    };
  }

  /** An Outline row's fields and a context over the latest props (the menu's schema writers). */
  menuItem(id: string): { fields: FieldDef<S, M, U>[]; ctx: ToolContext<S, M, U> } | null {
    for (const section of this.outline.sections) {
      const row = section.rows.find((r) => r.id === id);
      if (row === undefined) continue;
      const fields = schemaFields(this.props.definition.schema.items[row.kind]);
      return { fields, ctx: this.ctx({ level: 'item', kind: row.kind, id }, null) };
    }
    return null;
  }

  /** The top block: headers, card slots, each section's settings and the open card's body. */
  private outlinePaneSignature(outline: OutlineViewModel, selection: Selection): Signature {
    const { schema, binding } = this.props.definition;
    const base = outlineSignature(outline);
    const footer = footerSignature(binding.footer);
    const open = selection?.level === 'item' ? selection.id : null;
    const parts: string[] = [targetKey(selection ?? TOOL_TARGET)];
    for (const section of outline.sections) {
      const sectionSchema = schema.sections[section.kind];
      const shown = [
        ...(sectionSchema?.headerField ? [sectionSchema.headerField] : []),
        ...(sectionSchema?.placement === 'axes'
          ? schemaFields(sectionSchema).filter((f) => f.row !== undefined)
          : schemaFields(sectionSchema)),
      ];
      const sectionCtx = this.ctx(
        { level: 'section', kind: section.kind, id: section.id },
        selection
      );
      parts.push(shown.map((f) => fieldSignature(f, sectionCtx)).join('|'));
      for (const row of section.rows) {
        const all = schemaFields(schema.items[row.kind]);
        const fields = row.id === open ? all : all.filter((f) => f.row !== undefined);
        const rowCtx = this.ctx({ level: 'item', kind: row.kind, id: row.id }, selection);
        parts.push(fields.map((f) => fieldSignature(f, rowCtx)).join('|'));
      }
    }
    return {
      text: `${base.text}\n${footer.text}\n${parts.join('\n')}`,
      refs: [...base.refs, ...footer.refs],
    };
  }

  /** The plot-wide sections: the tool's fields and the `placement: 'axes'` sections'. */
  private plotPaneSignature(
    outline: OutlineViewModel,
    outlineSig: Signature,
    raw: Selection
  ): Signature {
    const { schema } = this.props.definition;
    const toolId = this.props.toolId ?? 'tool';
    const selection = resolveSelection(outline, raw);
    const toolCtx = this.ctx({ level: 'tool', kind: toolId, id: toolId }, selection);
    const parts = [
      ...schemaFields(schema.tool).map((f) => fieldSignature(f, toolCtx)),
      ...schema.tool.tabs.map((tab) => tab.summary?.(toolCtx) ?? ''),
    ];
    for (const section of outline.sections) {
      const sectionSchema = schema.sections[section.kind];
      if (sectionSchema?.placement !== 'axes') continue;
      const ctx = this.ctx({ level: 'section', kind: section.kind, id: section.id }, selection);
      parts.push(
        schemaFields(sectionSchema)
          .map((f) => fieldSignature(f, ctx))
          .join('|')
      );
    }
    return {
      text: `${targetKey(selection ?? TOOL_TARGET)}\n${outlineSig.text}\n${parts.join('\n')}`,
      refs: outlineSig.refs,
    };
  }

  /** Take the latest props; decide which pane renders with the latest model. */
  sync(props: WorkbenchLayoutProps<S, M, U>, selection: Selection): void {
    this.props = props;
    const last = this.last;
    // A state write, a new ui record or schema, or changed capabilities render both halves.
    let all =
      last === null ||
      last.state !== props.state ||
      last.ui !== props.ui ||
      last.schema !== props.definition.schema;
    if (last === null || !sameRecord(this.capabilities, props.capabilities)) {
      all = true;
      this.capabilities = props.capabilities;
    }
    if (!sameList(this.catalog, props.catalog)) this.catalog = props.catalog;

    const raw = props.definition.binding.outline(props.state, props.model);
    const rawSig = outlineSignature(raw);
    const outlineSig = this.outlinePaneSignature(raw, selection);
    const plotSig = this.plotPaneSignature(raw, rawSig, selection);

    if (all || !sameSignature(this.outlineSig, outlineSig)) this.outlineModel = props.model;
    if (all || !sameSignature(this.plotSig, plotSig)) this.plotModel = props.model;
    if (!sameSignature(this.rawSig, rawSig)) this.outline = raw;

    this.outlineSig = outlineSig;
    this.plotSig = plotSig;
    this.rawSig = rawSig;
    this.last = { state: props.state, ui: props.ui, schema: props.definition.schema };
  }
}

// ------------------------------------------------------------- canvas slot --

/**
 * The canvas as a store: the layout writes its latest children, the slot
 * inside the (memoized) Sidebar renders them. A new canvas element therefore
 * renders the canvas alone, never the Sidebar and its panes.
 */
class CanvasStore {
  private shown: ReactNode;
  private latest: ReactNode;
  private readonly listeners = new Set<() => void>();

  constructor(children: ReactNode) {
    this.shown = children;
    this.latest = children;
  }

  /** Take the latest children (render phase; publishes nothing). */
  take(children: ReactNode): void {
    this.latest = children;
  }

  /** Publish the children taken last, if they changed (commit phase). */
  publish(): void {
    if (Object.is(this.shown, this.latest)) return;
    this.shown = this.latest;
    for (const l of [...this.listeners]) l();
  }

  readonly get = (): ReactNode => this.shown;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

function CanvasSlot({ store }: { store: CanvasStore }) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ------------------------------------------------------------------ layout --

/** The given store, or one created for this mount. */
function useOwn<T>(given: T | undefined, create: () => T): T {
  const [own] = useState(() => (given === undefined ? create() : null));
  return given ?? (own as T);
}

export function WorkbenchLayout<S, M, U extends ToolUi = ToolUi>(
  props: WorkbenchLayoutProps<S, M, U>
): ReactNode {
  const { state, ui, archiver, toolId, children } = props;
  const selection = useOwn(props.selection, createSelectionStore);
  const registry = useOwn(props.actions, createActionRegistry);
  // A new selection renders the layout, so both halves get the latest model with it.
  const current = useSyncExternalStore(selection.subscribe, selection.get, selection.get);

  const [source] = useState(() => new LayoutSource<S, M, U>());
  source.sync(props, current.selection);
  const outline = source.outline;

  // The selection follows the outline: a removed item falls back to its section.
  useEffect(() => {
    selection.reconcile(outline);
  }, [selection, outline]);

  useQuickOpenShortcut();

  // Under the host bar the host draws the tool's actions, so the bar is not
  // rendered, but its shortcuts still bind. Read once per mount.
  const [hostBar] = useState(() => hostBarPage());
  useActionShortcuts(registry, { hostBar });
  // ...and the host's tile bar is fed from the registry...
  useToolActionsPublisher(registry, { state: props.hostState, hostBar });
  // ...and a pick there comes back as `canopy:tool-invoke` and runs here.
  useToolInvoke(registry, { hostBar });

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const propertiesRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const root = rootRef.current;
      const target = e.target;
      // React bubbles portal events to the root; only DOM descendants count.
      if (root === null || !(target instanceof Element) || !root.contains(target)) return;
      if (target.closest(DIALOG) !== null) return;
      const sidebar = root.querySelector('.wb-sidebar');
      const onSurface =
        (sidebar?.contains(target) ?? false) || (canvasRef.current?.contains(target) ?? false);
      if (!onSurface) return;
      if (root.querySelector(ROW_DRAGGING) !== null) return;

      selection.reset();
      const pane = root.querySelector(PROPERTIES_PANE);
      if (pane !== null && pane.closest('[hidden]') === null) propertiesRef.current?.focus();
    },
    [selection]
  );

  // The menus' Hide / Move to axis / Inspect / Create formula / Remove, read
  // from each item's own fields over the latest props.
  const [menuWriters] = useState(() =>
    schemaMenuWriters<S, M, U>({
      item: (id) => source.menuItem(id),
      remove: (id) => source.definition.binding.ops.remove(id),
    })
  );

  const [canvas] = useState(() => new CanvasStore(children));
  canvas.take(children);
  useLayoutEffect(() => canvas.publish());

  const shared = source.definition;
  const update = source.update;
  const capabilities = source.capabilities;
  const outlineModel = source.outlineModel;
  const plotModel = source.plotModel;
  const catalog = source.catalog;

  const outlinePane = useMemo(
    () => (
      <MemoOutline
        definition={shared}
        state={state}
        model={outlineModel}
        ui={ui}
        update={update}
        capabilities={capabilities}
        catalog={catalog}
        archiver={archiver}
      />
    ),
    [shared, state, outlineModel, ui, update, capabilities, catalog, archiver]
  );
  const plotPane = useMemo(
    () => (
      <MemoPlotSettings
        definition={shared}
        state={state}
        model={plotModel}
        ui={ui}
        update={update}
        capabilities={capabilities}
        toolId={toolId}
      />
    ),
    [shared, state, plotModel, ui, update, capabilities, toolId]
  );
  const [memory] = useState(() => new OpenMemory());
  const panel = useMemo(
    () => (
      <div
        ref={propertiesRef}
        className="wb-workbench__properties wb-panel"
        tabIndex={-1}
        aria-label="Plot properties"
      >
        <OpenMemoryProvider memory={memory}>
          {outlinePane}
          {plotPane}
        </OpenMemoryProvider>
      </div>
    ),
    [memory, outlinePane, plotPane]
  );
  const canvasSlot = useMemo(
    () => (
      <div ref={canvasRef} className="wb-workbench__canvas" data-wb-surface="canvas">
        <CanvasSlot store={canvas} />
      </div>
    ),
    [canvas]
  );

  return (
    <SelectionProvider store={selection}>
      <CanvasActionsProvider registry={registry}>
        <ContextMenuProvider schemaWriters={menuWriters}>
          <div className="wb-workbench" ref={rootRef} onKeyDown={onKeyDown}>
            {hostBar ? null : (
              <div className="wb-workbench__actions">
                <ActionsBar registry={registry} />
              </div>
            )}
            <div className="wb-workbench__body">
              <MemoSidebar store={props.arrangement} canvas={canvasSlot}>
                {panel}
              </MemoSidebar>
            </div>
          </div>
        </ContextMenuProvider>
      </CanvasActionsProvider>
    </SelectionProvider>
  );
}
