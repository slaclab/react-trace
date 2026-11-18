// The menu writers every tool gets from its own schema: each one reads a field
// the item's card already has, so the menu and the card can never disagree.
//
//   Hide / Show     the item's eye (`row: 'eye'` toggle)
//   Move to axis ›  its Plot on select with id `y-axis` (Trace's)
//   Inspect data    its action field `inspect-data`
//   Create formula  its action field `create-formula`
//   Remove          the binding's `ops.remove`
//   A drawing's     an item with the action field `annotation-delete`: Delete
//   Edit / Lock /   runs it, Lock / Unlock its `row: 'lock'` toggle, Edit
//   Delete          opens its card (the source's `open`); the header is its
//                   row label
//
// A field the item does not have, or does not show now, leaves its action out.
import type { FieldDef, ToolContext, ToolUi } from '../types';
import { isFieldShown } from '../fields/logic';
import type { ContextMenuWriters, DrawingOffer, MenuSignal, Offer } from './registry';

/** The field ids the menu reads. */
export const MENU_FIELDS = Object.freeze({
  moveTo: 'y-axis',
  inspect: 'inspect-data',
  createFormula: 'create-formula',
  deleteDrawing: 'annotation-delete',
} as const);

/** What the writers read: an item's fields and context, and the remove op. */
export interface SchemaMenuSource<S, M, U extends ToolUi> {
  /** The item's fields and a context over the latest props; null when the id is no row. */
  item(id: string): { fields: FieldDef<S, M, U>[]; ctx: ToolContext<S, M, U> } | null;
  remove(id: string): void;
  /** Select the row and open its card; absent, the drawing menu offers no Edit. */
  open?(id: string): void;
  /** The row's label (the drawing menu's header). */
  label?(id: string): string | null;
}

export function schemaMenuWriters<S, M, U extends ToolUi>(
  src: SchemaMenuSource<S, M, U>
): ContextMenuWriters {
  const field = (s: MenuSignal, pick: (f: FieldDef<S, M, U>) => boolean) => {
    const item = src.item(s.id);
    if (item === null) return null;
    const f = item.fields.find(pick);
    return f !== undefined && isFieldShown(f, item.ctx) ? { f, ctx: item.ctx } : null;
  };
  const action = (s: MenuSignal, id: string): Offer | null => {
    const hit = field(s, (f) => f.id === id && f.kind === 'action');
    if (hit === null || hit.f.kind !== 'action') return null;
    const { f, ctx } = hit;
    return { run: () => f.run(ctx), disabled: f.disabled?.(ctx) ?? false };
  };
  return {
    hide: (s) => {
      const hit = field(s, (f) => f.kind === 'toggle' && f.row === 'eye');
      if (hit === null || hit.f.kind !== 'toggle') return null;
      const { f, ctx } = hit;
      return { hidden: !f.get(ctx), set: (hidden) => f.set(ctx, !hidden) };
    },
    moveTo: (s) => {
      const hit = field(s, (f) => f.id === MENU_FIELDS.moveTo && f.kind === 'select');
      if (hit === null || hit.f.kind !== 'select') return null;
      const { f, ctx } = hit;
      const current = f.get(ctx);
      return f.options(ctx).map((o) => ({
        label: o.label,
        selected: o.value === current,
        disabled: o.disabled ?? false,
        run: () => f.set(ctx, o.value),
      }));
    },
    inspect: (s) => action(s, MENU_FIELDS.inspect),
    createFormula: (s) => action(s, MENU_FIELDS.createFormula),
    remove: (s) => (src.item(s.id) === null ? null : { run: () => src.remove(s.id) }),
    // A drawing is an item with the drawing card's Delete field; its lock
    // is the row's lock toggle.
    drawing: (id): DrawingOffer | null => {
      const item = src.item(id);
      if (item === null) return null;
      const { fields, ctx } = item;
      const del = fields.find((f) => f.id === MENU_FIELDS.deleteDrawing);
      if (del === undefined || del.kind !== 'action') return null;
      const lock = fields.find((f) => f.kind === 'toggle' && f.row === 'lock');
      const lockShown = lock !== undefined && lock.kind === 'toggle' && isFieldShown(lock, ctx);
      const open = src.open;
      return {
        name: src.label?.(id) ?? '',
        locked: lockShown ? lock.get(ctx) : false,
        edit: open ? () => open(id) : undefined,
        setLocked: lockShown ? (locked) => lock.set(ctx, locked) : undefined,
        remove: isFieldShown(del, ctx) ? () => del.run(ctx) : undefined,
      };
    },
  };
}
