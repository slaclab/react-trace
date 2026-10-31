// The top block of the properties panel: what the plot shows, as lists. The
// component keeps the name `Outline` because the tool contract calls this
// view-model `OutlineViewModel`; it is not a separate pane.
//
// Renders the tool's `binding.outline(state, model)` view-model:
//
// - Groups: consecutive sections whose kinds name the same `group` (default:
//   the section's title) share one heading, the peer lists of the panel —
//   Signals, then a tool's Reference / X axis PV / Trigger, then Drawings. A
//   group of one section folds the section header into the group heading
//   (title · count · header controls); a group of several shows each section
//   as a sub-heading (chevron · unit tag · title · count · header controls),
//   which is the collapse target. The section's `headerField` and any
//   section field with `row: 'eye'` render inline with `data-testid=<field id>`
//   (placement `header`).
// - Cards: one per row. The head is status dot · swatch · name, then the
//   hover-revealed eye, lock and remove. Swatch and eye are the item's own
//   Colour and Visible fields rendered small (placement `row`: no `#id`, no
//   testid) with the same getter, setter and dot, so a card has a swatch iff
//   its item kind has a `row: 'swatch'` field. A `row: 'lock'` toggle
//   renders as a lock glyph after the eye; a lock that is on stays visible at
//   rest. A click on the head opens the card in place (it is the item
//   selection) or closes it; slot clicks do neither. The open card shows the
//   item's field groups as titled blocks (`FieldBlock`), its eye and lock
//   fields left to the head.
// - Section settings: a section kind with `placement: 'group'` (the default)
//   shows its own fields under its cards and add row, the header controls left
//   out (Reference: Draw as, Spread band; Trigger: Period, Fire on).
// - Hidden rows (eye off) and `muted` sections render muted; `footer` actions
//   render below the last group, a disabled one visible with its reason.
//
// - Card drag: the Outline owns its own `DndContext` for card drags. A
//   card head is draggable by pointer (past 6 px, so a click still opens it)
//   or by keyboard from the focused head (@dnd-kit defaults); each section is
//   a drop target. Before a drop is offered the tool's `moveRefusal(item,
//   section)` is asked: a refused target shows a "no drop" state with the
//   reason and a drop there never calls `ops.move`; an allowed drop calls
//   `ops.move` once. A drop on the card's own section, or outside every
//   section, does nothing.
//
// Rate rule: the view-model is compared structurally (sections by header
// fields, rows by id + kind + status + label + refusal) and the previous
// objects are kept when equal, so a model tick that changes nothing re-renders
// no header or card head. Slots and header fields re-render through their own
// field getters: the Outline computes each slot's value, dot and gates every
// render and a head re-renders only when they change. Every `ctx` handed to a
// field reads the latest props through a source object, so a setter never
// sees the state of a card's last render.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ChevronDown, ChevronRight, Locked, TrashCan, Unlocked } from '@carbon/icons-react';
import { FieldBlock } from './FieldBlock';
import { useContextMenu } from './contextMenu/context';
import {
  FieldControl,
  disabledReason,
  fieldSignature,
  isFieldModified,
  isFieldShown,
  schemaFields,
} from './fields';
import { OutlineAddRow } from './OutlineAddRow';
import { sameHead, sameRow } from './outlineCompare';
import { useWorkbenchSelection } from './selection';
import { outlineGroups } from './outlineGroups';
import type {
  Action,
  Capabilities,
  FieldDef,
  OutlineRow,
  OutlineSection,
  OutlineViewModel,
  Selection,
  Target,
  ToolContext,
  ToolDefinition,
  ToolUi,
} from './types';

export interface OutlineProps<S, M, U extends ToolUi = ToolUi> {
  definition: ToolDefinition<S, M, U>;
  state: S;
  model: M;
  ui: U;
  /** The tool's single writer. */
  update(fn: (state: S) => S): void;
  capabilities: Capabilities;
  /** Channel catalog for the add rows; the host's by default. */
  catalog?: readonly string[];
  archiver?: string;
}

// ----------------------------------------------------------------- source --

/**
 * The latest props, read by every `ctx` the Outline hands to a field. Memoized
 * rows keep their last render's props, so a ctx built from those would let a
 * setter write over a newer state; the getters here always read the current one.
 */
class OutlineSource<S, M, U extends ToolUi> {
  private props!: OutlineProps<S, M, U>;
  private selection: Selection = null;
  private previous: OutlineViewModel | null = null;

  set(props: OutlineProps<S, M, U>, selection: Selection): void {
    this.props = props;
    this.selection = selection;
  }

  get definition(): ToolDefinition<S, M, U> {
    return this.props.definition;
  }

  /** `next` with every structurally equal section and row replaced by the previous object. */
  stabilize(next: OutlineViewModel): OutlineViewModel {
    const stable = stabilizeOutline(this.previous, next);
    this.previous = stable;
    return stable;
  }

  ctx(target: Target): ToolContext<S, M, U> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const source = this;
    return {
      get state() {
        return source.props.state;
      },
      get model() {
        return source.props.model;
      },
      update: (fn) => source.props.update(fn),
      get selection() {
        return source.selection;
      },
      target,
      get capabilities() {
        return source.props.capabilities;
      },
      get ui() {
        return source.props.ui;
      },
    };
  }
}

// --------------------------------------------------------- structural compare --

function stabilizeSection(prev: OutlineSection | undefined, next: OutlineSection): OutlineSection {
  if (prev === undefined) return next;
  const prevRows = new Map(prev.rows.map((row) => [row.id, row]));
  let reused = prev.rows.length === next.rows.length;
  const rows = next.rows.map((row, index) => {
    const old = prevRows.get(row.id);
    if (old !== undefined && sameRow(old, row)) {
      if (prev.rows[index] !== old) reused = false;
      return old;
    }
    reused = false;
    return row;
  });
  if (reused && sameHead(prev, next)) return prev;
  return { ...next, rows };
}

function stabilizeOutline(prev: OutlineViewModel | null, next: OutlineViewModel): OutlineViewModel {
  if (prev === null) return next;
  const prevSections = new Map(prev.sections.map((s) => [s.id, s]));
  const sections = next.sections.map((s) => stabilizeSection(prevSections.get(s.id), s));
  const same =
    prev.sections.length === sections.length && sections.every((s, i) => s === prev.sections[i]);
  return same ? prev : { ...next, sections };
}

// ------------------------------------------------------------- slot fields --

interface RowSlots<S, M, U extends ToolUi> {
  swatch?: FieldDef<S, M, U>;
  eye?: FieldDef<S, M, U>;
  lock?: FieldDef<S, M, U>;
}

/**
 * The item kind's row slots: its `row: 'swatch'` Colour, `row: 'eye'` Visible
 * and `row: 'lock'` toggle fields.
 */
function rowSlots<S, M, U extends ToolUi>(
  definition: ToolDefinition<S, M, U>,
  kind: string
): RowSlots<S, M, U> {
  const schema = definition.schema.items[kind];
  if (schema === undefined) return {};
  const fields = schemaFields(schema);
  return {
    swatch: fields.find((f) => f.kind === 'colour' && f.row === 'swatch'),
    eye: fields.find((f) => f.kind === 'toggle' && f.row === 'eye'),
    lock: fields.find((f) => f.kind === 'toggle' && f.row === 'lock'),
  };
}

/** The row's lock glyph: a pressed-state button writing the toggle through its setter. */
function LockSlot<S, M, U extends ToolUi>({
  field,
  ctx,
}: {
  field: FieldDef<S, M, U>;
  ctx: ToolContext<S, M, U>;
}) {
  if (field.kind !== 'toggle') return null;
  const on = field.get(ctx);
  const reason = disabledReason(field, ctx);
  const title = reason === false ? field.label : `${field.label}: ${reason}`;
  return (
    <span
      className={`wb-outline-row__slot wb-outline-row__lock${on ? ' wb-outline-row__lock--on' : ''}`}
      onClick={stop}
    >
      <button
        type="button"
        className="wb-outline-row__lock-button"
        aria-label={field.label}
        title={title}
        aria-pressed={on}
        disabled={reason !== false}
        onClick={() => field.set(ctx, !on)}
      >
        {on ? <Locked size={16} /> : <Unlocked size={16} />}
      </button>
    </span>
  );
}

/** The section kind's header controls: its `headerField`, then a `row: 'eye'` field. */
function headerFields<S, M, U extends ToolUi>(
  definition: ToolDefinition<S, M, U>,
  kind: string
): FieldDef<S, M, U>[] {
  const schema = definition.schema.sections[kind];
  if (schema === undefined) return [];
  const out: FieldDef<S, M, U>[] = [];
  if (schema.headerField !== undefined) out.push(schema.headerField);
  const eye = schemaFields(schema).find((f) => f.kind === 'toggle' && f.row === 'eye');
  if (eye !== undefined && !out.some((f) => f === eye || f.id === eye.id)) out.push(eye);
  return out;
}

const stop = (e: MouseEvent) => e.stopPropagation();

// ----------------------------------------------------------------- header --

interface HeaderProps<S, M, U extends ToolUi> {
  source: OutlineSource<S, M, U>;
  id: string;
  kind: string;
  title: string;
  unit?: string;
  count: number;
  capacity?: number;
  /** A group heading (one section) or a section sub-heading (several). */
  variant: 'group' | 'section';
  collapsed: boolean;
  fields: FieldDef<S, M, U>[];
  /** The header fields' signatures; a change re-renders the header. */
  signature: string;
  onToggle(id: string): void;
}

function SectionHeaderImpl<S, M, U extends ToolUi>({
  source,
  id,
  kind,
  title,
  unit,
  count,
  capacity,
  variant,
  collapsed,
  fields,
  onToggle,
}: HeaderProps<S, M, U>) {
  const target: Target = { level: 'section', kind, id };
  const ctx = source.ctx(target);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const group = variant === 'group';
  return (
    <div
      className={`wb-outline-section__header wb-outline-section__header--${variant}`}
      onClick={group ? undefined : () => onToggle(id)}
    >
      {group ? (
        <h3 className="wb-group__heading">{title}</h3>
      ) : (
        <button type="button" className="wb-outline-section__toggle" aria-expanded={!collapsed}>
          <Chevron size={16} className="wb-outline-section__chevron" />
          {unit !== undefined && <span className="wb-outline-section__unit">{unit}</span>}
          <span className="wb-outline-section__title">{title}</span>
        </button>
      )}
      <span className="wb-outline-section__count">
        {capacity !== undefined ? `${count}/${capacity}` : `${count}`}
      </span>
      {fields.map((field) =>
        isFieldShown(field, ctx) ? (
          <span key={field.id} className="wb-outline-section__control" onClick={stop}>
            <FieldControl field={field} ctx={ctx} placement="header" />
          </span>
        ) : null
      )}
    </div>
  );
}

const SectionHeader = memo(SectionHeaderImpl) as typeof SectionHeaderImpl;

// ------------------------------------------------------- section settings --

/** A `placement: 'group'` section's own fields, under its cards. */
function SectionSettings<S, M, U extends ToolUi>({
  source,
  section,
  omit,
}: {
  source: OutlineSource<S, M, U>;
  section: OutlineSection;
  omit: (field: FieldDef<S, M, U>) => boolean;
}) {
  const schema = source.definition.schema.sections[section.kind];
  if (schema === undefined || schema.placement === 'axes') return null;
  const ctx = source.ctx({ level: 'section', kind: section.kind, id: section.id });
  const blocks = schema.tabs.filter((tab) => tab.id !== 'code');
  if (blocks.length === 0) return null;
  return (
    <div className="wb-outline-section__settings">
      {blocks.map((tab) => (
        <FieldBlock
          key={tab.id}
          block={tab}
          ctx={ctx}
          memoryKey={`section:${section.kind}:${tab.id}`}
          omit={omit}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- card --

interface RowProps<S, M, U extends ToolUi> {
  source: OutlineSource<S, M, U>;
  sectionId: string;
  row: OutlineRow;
  swatch?: FieldDef<S, M, U>;
  eye?: FieldDef<S, M, U>;
  lock?: FieldDef<S, M, U>;
  /** The slots' and, while open, the body's signatures; a change re-renders the card. */
  signature: string;
  swatchModified: boolean;
  hidden: boolean;
  open: boolean;
  onToggle(target: Target, open: boolean): void;
  onRemove(itemId: string): void;
  /** Picked for a several-row menu (primary- or Shift-click). */
  picked: boolean;
  /** Toggle a row's pick; null clears every pick. */
  onPick(itemId: string | null): void;
  /** A right-click on the head: the signal menu. */
  onMenu(itemId: string, e: MouseEvent): void;
}

/**
 * The drag half of a card. It consumes @dnd-kit's context, which changes with
 * every render of the `DndContext`, so it stays thin and hands only stable
 * handles and the `isDragging` primitive to the memoized card: an Outline
 * re-render re-renders no card (rate rule).
 */
function RowImpl<S, M, U extends ToolUi>(props: RowProps<S, M, U>) {
  const { row, sectionId } = props;
  const drag: RowDrag = { itemId: row.id, sectionId, label: row.label };
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: `${ROW_DRAG_PREFIX}${row.id}`,
    data: drag,
    attributes: { role: 'group', roleDescription: 'draggable card' },
  });
  // The head is the activator, so Enter/Space on its name or slot buttons
  // keeps their own meaning and only the focused head starts a drag.
  const dragRef = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef]
  );
  const stableListeners = useStableListeners(listeners);
  return (
    <RowBody
      {...props}
      dragRef={dragRef}
      dragAttributes={attributes}
      dragListeners={stableListeners}
      isDragging={isDragging}
    />
  );
}

/**
 * `listeners` with a stable identity. @dnd-kit rebuilds them whenever its
 * internal context changes (every `DndContext` render); the handler set is
 * fixed by the sensors, so stable forwarders to the latest handlers keep the
 * memoized card from re-rendering on every Outline render.
 */
function useStableListeners(listeners: DraggableSyntheticListeners): DraggableSyntheticListeners {
  const latest = useRef(listeners);
  useLayoutEffect(() => {
    latest.current = listeners;
  });
  const names = listeners ? Object.keys(listeners).sort().join(',') : '';
  return useMemo(() => {
    if (names === '') return undefined;
    const stable: Record<string, (event: SyntheticEvent) => void> = {};
    for (const name of names.split(',')) {
      stable[name] = (event) => latest.current?.[name]?.(event);
    }
    return stable;
  }, [names]);
}

interface RowBodyProps<S, M, U extends ToolUi> extends RowProps<S, M, U> {
  dragRef(node: HTMLElement | null): void;
  dragAttributes: DraggableAttributes;
  dragListeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

/** An item's eye and lock live on the card head, never in its body. */
const onHead = (field: { row?: string }) => field.row === 'eye' || field.row === 'lock';

/** The open card's body: the item's field groups as titled blocks. */
function CardBody<S, M, U extends ToolUi>({
  source,
  target,
}: {
  source: OutlineSource<S, M, U>;
  target: Target;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const schema = source.definition.schema.items[target.kind];
  if (schema === undefined) return null;
  const ctx = source.ctx(target);
  const blocks = schema.tabs.filter((tab) => tab.id !== 'code');
  return (
    <div ref={ref} className="wb-card__body" data-level="item" data-kind={target.kind}>
      {blocks.map((tab) => (
        <FieldBlock
          key={tab.id}
          block={tab}
          ctx={ctx}
          memoryKey={`item:${target.kind}:${tab.id}`}
          heading={blocks.length > 1}
          omit={onHead}
        />
      ))}
    </div>
  );
}

function RowBodyImpl<S, M, U extends ToolUi>({
  source,
  sectionId,
  row,
  swatch,
  eye,
  lock,
  swatchModified,
  hidden,
  open,
  onToggle,
  onRemove,
  picked,
  onPick,
  onMenu,
  dragRef,
  dragAttributes,
  dragListeners,
  isDragging,
}: RowBodyProps<S, M, U>) {
  const target: Target = { level: 'item', kind: row.kind, id: row.id };
  const ctx = source.ctx(target);
  const statusText = row.refusal ?? row.status;
  const className = [
    'wb-card',
    hidden ? 'wb-card--muted' : '',
    open ? 'wb-card--open' : '',
    picked ? 'wb-card--picked' : '',
    isDragging ? 'wb-card--dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li className={className} data-card-id={row.id}>
      <div
        ref={dragRef}
        {...dragAttributes}
        {...dragListeners}
        data-row-id={row.id}
        data-section={sectionId}
        className={`wb-outline-row wb-card__head canopy-row${
          isDragging ? ' wb-outline-row--dragging' : ''
        }`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            onPick(row.id);
            return;
          }
          onPick(null);
          onToggle(target, !open);
        }}
        onContextMenu={(e) => onMenu(row.id, e)}
      >
        <span
          className={`wb-outline-row__status wb-outline-row__status--${row.status}`}
          role="img"
          aria-label={`Status: ${statusText}`}
          title={statusText}
        />
        {swatch !== undefined && isFieldShown(swatch, ctx) && (
          <span className="wb-outline-row__slot wb-outline-row__swatch" onClick={stop}>
            <FieldControl field={swatch} ctx={ctx} placement="row" />
            {swatchModified && (
              <span
                className="wb-outline-row__modified"
                aria-hidden="true"
                title={`${swatch.label} modified`}
              />
            )}
          </span>
        )}
        <button
          type="button"
          className="wb-outline-row__name canopy-row__label"
          aria-expanded={open}
          title={row.label}
        >
          {row.label}
        </button>
        {eye !== undefined && isFieldShown(eye, ctx) && (
          <span
            className={`wb-outline-row__slot wb-outline-row__eye${hidden ? ' wb-outline-row__eye--off' : ''}`}
            onClick={stop}
          >
            <FieldControl field={eye} ctx={ctx} placement="row" />
          </span>
        )}
        {lock !== undefined && isFieldShown(lock, ctx) && <LockSlot field={lock} ctx={ctx} />}
        <button
          type="button"
          className="wb-outline-row__remove"
          aria-label={`Remove ${row.label}`}
          title={`Remove ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(row.id);
          }}
        >
          <TrashCan size={16} />
        </button>
      </div>
      {open && <CardBody source={source} target={target} />}
    </li>
  );
}

const RowBody = memo(RowBodyImpl) as typeof RowBodyImpl;
const Row = memo(RowImpl) as typeof RowImpl;

// ------------------------------------------------------------------- drag --

const ROW_DRAG_PREFIX = 'wb-outline-row:';
const SECTION_DROP_PREFIX = 'wb-outline-section:';

/** The payload a dragged row carries. */
interface RowDrag {
  itemId: string;
  /** The section the row is in when the drag starts. */
  sectionId: string;
  label: string;
}

/** The payload a section drop target carries. */
interface SectionDrop {
  sectionId: string;
}

/** The section under the dragged row and the tool's refusal for it. */
interface DropTarget {
  sectionId: string;
  refusal: string | null;
}

/** Pointer drags hit the section under the pointer; keyboard drags use the dragged rect. */
const collision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

interface SectionFrameProps {
  id: string;
  className: string;
  /** This section is the target of an allowed move. */
  drop: boolean;
  /** The tool's reason this section refuses the dragged row; null when it does not. */
  refusal: string | null;
  children: ReactNode;
}

/** A section container that is a drop target for row drags. */
function SectionFrame({ id, className, drop, refusal, children }: SectionFrameProps) {
  const payload: SectionDrop = { sectionId: id };
  const { setNodeRef } = useDroppable({ id: `${SECTION_DROP_PREFIX}${id}`, data: payload });
  const classes = [
    className,
    drop ? 'wb-outline-section--drop' : '',
    refusal !== null ? 'wb-outline-section--no-drop' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div ref={setNodeRef} className={classes} data-section-id={id} title={refusal ?? undefined}>
      {children}
    </div>
  );
}

const AddRow = memo(OutlineAddRow);

// ----------------------------------------------------------------- footer --

function footerTitle(action: Action): string {
  return action.disabled ? `${action.label} — ${action.disabled}` : action.label;
}

function OutlineFooter({ actions }: { actions: Action[] }): ReactNode {
  if (actions.length === 0) return null;
  return (
    <div className="wb-outline__footer">
      {actions.map((action) => {
        const Icon = action.icon;
        const disabled = Boolean(action.disabled);
        return (
          <button
            key={action.id}
            type="button"
            className={`wb-outline__footer-action${disabled ? ' wb-outline__footer-action--disabled' : ''}`}
            title={footerTitle(action)}
            // aria-disabled, not `disabled`: the reason stays hoverable.
            aria-disabled={disabled || undefined}
            aria-pressed={action.kind === 'toggle' ? Boolean(action.pressed) : undefined}
            onClick={() => {
              if (!action.disabled) action.onClick();
            }}
          >
            <Icon size={16} />
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- outline --

function selectedId(selection: Selection, level: 'section' | 'item'): string | null {
  return selection !== null && selection.level === level ? selection.id : null;
}

/** A heading as a stable attribute value: `Signals` → `signals`, `X axis PV` → `x-axis-pv`. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function Outline<S, M, U extends ToolUi = ToolUi>(props: OutlineProps<S, M, U>) {
  const { definition, state, model, catalog, archiver } = props;
  const { selection, store } = useWorkbenchSelection();
  const [source] = useState(() => new OutlineSource<S, M, U>());
  source.set(props, selection);

  const binding = definition.binding;
  const raw = useMemo(() => binding.outline(state, model), [binding, state, model]);
  const outline = useMemo(() => source.stabilize(raw), [source, raw]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const onToggleSection = useCallback(
    (id: string) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] })),
    []
  );
  const onToggleCard = useCallback(
    (target: Target, open: boolean) => {
      if (open) store.select(target, 'user');
      else store.reset();
    },
    [store]
  );
  const onRemove = useCallback(
    (itemId: string) => source.definition.binding.ops.remove(itemId),
    [source]
  );
  const add = useCallback(
    (sectionId: string, pv: string) => source.definition.binding.ops.add(sectionId, pv),
    [source]
  );

  // ------------------------------------------------------- right-click menu --

  // Rows picked with primary- or Shift-click: a right-click on one of them
  // opens the menu for all of them (Copy PV names, Hide, Remove…).
  const menus = useContextMenu();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const outlineRef = useRef(outline);
  const onPick = useCallback((itemId: string | null) => {
    setPicked((prev) => {
      if (itemId === null) return prev.size === 0 ? prev : new Set();
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);
  const pickedRef = useRef(picked);
  useLayoutEffect(() => {
    outlineRef.current = outline;
    pickedRef.current = picked;
  });
  const onMenu = useCallback(
    (itemId: string, e: MouseEvent) => {
      if (menus === null) return;
      const pickedNow = pickedRef.current;
      const rows = outlineRef.current.sections.flatMap((section) => section.rows.map((r) => r.id));
      const ids =
        pickedNow.has(itemId) && pickedNow.size > 1
          ? rows.filter((id) => pickedNow.has(id))
          : [itemId];
      const at = { x: e.clientX, y: e.clientY, target: e.currentTarget.ownerDocument.body };
      if (menus.openSignals(ids, at)) e.preventDefault();
    },
    [menus]
  );

  // ------------------------------------------------------------ card drag --

  const [dragging, setDragging] = useState<RowDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );
  /** The target under `over` for `from`, refusal asked of the tool's latest rule; null for none or home. */
  const targetOf = useCallback(
    (from: RowDrag | undefined, over: SectionDrop | undefined): DropTarget | null => {
      if (from === undefined || over === undefined) return null;
      if (over.sectionId === from.sectionId) return null;
      const refusal = source.definition.binding.moveRefusal(from.itemId, over.sectionId);
      return { sectionId: over.sectionId, refusal };
    },
    [source]
  );
  const onDragStart = useCallback((event: DragStartEvent) => {
    setDragging((event.active.data.current as RowDrag | undefined) ?? null);
    setDropTarget(null);
  }, []);
  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      setDropTarget(
        targetOf(
          event.active.data.current as RowDrag | undefined,
          event.over?.data.current as SectionDrop | undefined
        )
      );
    },
    [targetOf]
  );
  const endDrag = useCallback(() => {
    setDragging(null);
    setDropTarget(null);
  }, []);
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      endDrag();
      const from = event.active.data.current as RowDrag | undefined;
      const target = targetOf(from, event.over?.data.current as SectionDrop | undefined);
      // Asked again at the drop: the state may have moved since the last hover.
      if (from === undefined || target === null || target.refusal !== null) return;
      source.definition.binding.ops.move(from.itemId, target.sectionId);
    },
    [endDrag, source, targetOf]
  );

  const schema = definition.schema;
  const slotsByKind = useMemo(() => {
    const kinds = Object.keys(schema.items);
    return new Map(kinds.map((kind) => [kind, rowSlots(definition, kind)]));
    // The schema is the static half; the slot fields follow it alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);
  const headerByKind = useMemo(() => {
    const kinds = Object.keys(schema.sections);
    return new Map(kinds.map((kind) => [kind, headerFields(definition, kind)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);
  /** A section's settings leave out what its header already shows. */
  const omitByKind = useMemo(() => {
    const out = new Map<string, (field: FieldDef<S, M, U>) => boolean>();
    for (const [kind, fields] of headerByKind) {
      const ids = new Set(fields.map((f) => f.id));
      out.set(kind, (field) => ids.has(field.id) || field.row !== undefined);
    }
    return out;
  }, [headerByKind]);
  const groups = useMemo(
    () => outlineGroups((kind) => schema.sections[kind]?.group, outline.sections),
    [schema, outline]
  );

  const openItem = selectedId(selection, 'item');

  const renderSection = (section: OutlineSection, variant: 'group' | 'section', title: string) => {
    const isCollapsed = variant === 'section' && collapsed[section.id] === true;
    const fields = headerByKind.get(section.kind) ?? NO_FIELDS;
    const headerCtx = source.ctx({ level: 'section', kind: section.kind, id: section.id });
    const headerSignature = fields.map((f) => fieldSignature(f, headerCtx)).join('|');
    const isTarget = dragging !== null && dropTarget?.sectionId === section.id;
    const refusal = isTarget ? dropTarget.refusal : null;
    return (
      <SectionFrame
        key={section.id}
        id={section.id}
        className={`wb-outline-section${section.muted ? ' wb-outline-section--muted' : ''}${
          isCollapsed ? ' wb-outline-section--collapsed' : ''
        }`}
        drop={isTarget && refusal === null}
        refusal={refusal}
      >
        <SectionHeader
          source={source}
          id={section.id}
          kind={section.kind}
          title={title}
          unit={variant === 'section' ? section.unit : undefined}
          count={section.count}
          capacity={section.capacity}
          variant={variant}
          collapsed={isCollapsed}
          fields={fields}
          signature={headerSignature}
          onToggle={onToggleSection}
        />
        {refusal !== null && (
          <p className="wb-outline-section__no-drop" role="status">
            {refusal}
          </p>
        )}
        {!isCollapsed && (
          <>
            <ul className="wb-outline-section__rows">
              {section.rows.map((row) => {
                const slots = slotsByKind.get(row.kind) ?? NO_SLOTS;
                const ctx = source.ctx({ level: 'item', kind: row.kind, id: row.id });
                const open = openItem === row.id;
                const swatchSig = slots.swatch ? fieldSignature(slots.swatch, ctx) : '';
                const eyeSig = slots.eye ? fieldSignature(slots.eye, ctx) : '';
                const lockSig = slots.lock ? fieldSignature(slots.lock, ctx) : '';
                // While open, the body's fields re-render the card too.
                const bodySig = open
                  ? schemaFields(schema.items[row.kind])
                      .map((f) => fieldSignature(f, ctx))
                      .join('|')
                  : '';
                const swatchModified =
                  slots.swatch !== undefined &&
                  isFieldShown(slots.swatch, ctx) &&
                  isFieldModified(slots.swatch, ctx);
                const hidden =
                  slots.eye !== undefined &&
                  slots.eye.kind === 'toggle' &&
                  isFieldShown(slots.eye, ctx) &&
                  slots.eye.get(ctx) === false;
                return (
                  <Row
                    key={row.id}
                    source={source}
                    sectionId={section.id}
                    row={row}
                    swatch={slots.swatch}
                    eye={slots.eye}
                    lock={slots.lock}
                    signature={`${swatchSig}|${eyeSig}|${lockSig}|${bodySig}`}
                    swatchModified={swatchModified}
                    hidden={hidden}
                    open={open}
                    onToggle={onToggleCard}
                    onRemove={onRemove}
                    picked={picked.has(row.id)}
                    onPick={onPick}
                    onMenu={onMenu}
                  />
                );
              })}
            </ul>
            <AddRow section={section} add={add} catalog={catalog} archiver={archiver} />
            <SectionSettings
              source={source}
              section={section}
              omit={omitByKind.get(section.kind) ?? omitNothing}
            />
          </>
        )}
      </SectionFrame>
    );
  };

  return (
    <div className="wb-outline" aria-label="Signals">
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        {groups.map((group) => (
          <div key={group.sections[0].id} className="wb-group" data-group={slug(group.title)}>
            {group.sections.length === 1 ? (
              renderSection(group.sections[0], 'group', group.title)
            ) : (
              <>
                <div className="wb-outline-section__header wb-outline-section__header--group">
                  <h3 className="wb-group__heading">{group.title}</h3>
                </div>
                {group.sections.map((section) => renderSection(section, 'section', section.title))}
              </>
            )}
          </div>
        ))}
        <DragOverlay dropAnimation={null}>
          {dragging !== null ? <div className="wb-outline__ghost">{dragging.label}</div> : null}
        </DragOverlay>
      </DndContext>
      <OutlineFooter actions={binding.footer ?? NO_ACTIONS} />
    </div>
  );
}

const NO_FIELDS: never[] = [];
const NO_SLOTS: RowSlots<never, never, never> = {};
const NO_ACTIONS: Action[] = [];
const omitNothing = () => false;
