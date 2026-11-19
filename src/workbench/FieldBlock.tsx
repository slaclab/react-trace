// One titled group of fields, as the properties panel shows it everywhere: a
// block of an open card, a section's settings under its cards, a plot-wide
// section's body.
//
// - The L1 and L2 fields in declared order (L1 first), then the read-only
//   Status group (`group: 'status'`, outside the L1 budget), then
//   the "More" disclosure holding the L3 fields: closed by default, its open
//   state remembered per `memoryKey` for as long as the panel lives, so
//   reopening a card keeps it.
// - A field whose `when(ctx)` is false is not rendered at all; a block, the
//   Status group or the disclosure with no shown field is not rendered either.
// - A field's `subgroup` prints a small sub-heading where it changes from the
//   field before it (Axes: `Y axis`, then `X axis`).
// - Every field renders through `Field` (placement `properties`, so it carries
//   its `#id`); the dot and reset are the field's own.

import type { ReactNode } from 'react';
import { ChevronRight } from '@carbon/icons-react';
import { blockGroups } from './blockGroups';
import { Field } from './fields';
import { OpenMemoryContext, useRememberedOpen, type OpenMemory } from './openMemory';
import type { FieldDef, TabDef, ToolContext, ToolUi } from './types';

/**
 * The L1 budget: at most this many L1 fields in a block, the Status group
 * excluded. Development builds warn once per block over it.
 */
const L1_BUDGET = 7;

// ----------------------------------------------------------- open memory --

export function OpenMemoryProvider({
  memory,
  children,
}: {
  memory: OpenMemory;
  children?: ReactNode;
}): ReactNode {
  return <OpenMemoryContext.Provider value={memory}>{children}</OpenMemoryContext.Provider>;
}

const overBudgetWarned = new WeakSet<object>();

/** Development check of the L1 budget; the Status group does not count. */
function checkL1Budget<S, M, U extends ToolUi>(block: TabDef<S, M, U>, owner: string): void {
  if (!import.meta.env.DEV || overBudgetWarned.has(block)) return;
  const l1 = block.fields.filter((f) => f.level === 'L1' && f.group !== 'status').length;
  if (l1 <= L1_BUDGET) return;
  overBudgetWarned.add(block);
  console.warn(
    `Properties: ${owner} block "${block.id}" declares ${l1} L1 fields (budget ${L1_BUDGET})`
  );
}

// ------------------------------------------------------------------- block --

export interface FieldBlockProps<S, M, U extends ToolUi> {
  block: TabDef<S, M, U>;
  ctx: ToolContext<S, M, U>;
  /** Where the More disclosure's open state is remembered (object kind + block id). */
  memoryKey: string;
  /** Show the block's label as a small heading. */
  heading?: boolean;
  /** Fields of the block left out here (rendered elsewhere, e.g. a row slot). */
  omit?: (field: FieldDef<S, M, U>) => boolean;
  /** Appended to every control's `#id` when the block is shown more than once. */
  idSuffix?: string;
}

export function FieldBlock<S, M, U extends ToolUi>({
  block,
  ctx,
  memoryKey,
  heading = false,
  omit,
  idSuffix,
}: FieldBlockProps<S, M, U>): ReactNode {
  const [moreOpen, setMoreOpen] = useRememberedOpen(`more:${memoryKey}`, false);
  checkL1Budget(block, memoryKey);
  const fields = omit ? block.fields.filter((f) => !omit(f)) : block.fields;
  const groups = blockGroups(fields, ctx);
  if (groups.main.length + groups.status.length + groups.more.length === 0) return null;
  const render = (field: FieldDef<S, M, U>) => (
    <Field key={field.id} field={field} ctx={ctx} placement="properties" idSuffix={idSuffix} />
  );
  const withSubheadings = (list: FieldDef<S, M, U>[]) => {
    let current: string | undefined;
    return list.flatMap((field) => {
      const out: ReactNode[] = [];
      if (field.subgroup !== undefined && field.subgroup !== current) {
        out.push(
          <h5 key={`sub:${field.subgroup}`} className="wb-block__subheading">
            {field.subgroup}
          </h5>
        );
      }
      current = field.subgroup;
      out.push(render(field));
      return out;
    });
  };
  return (
    <div className="wb-block" data-block={block.id}>
      {heading && <h4 className="wb-block__heading">{block.label}</h4>}
      {withSubheadings(groups.main)}
      {groups.status.length > 0 && (
        <section className="wb-block__status" aria-label="Status">
          {groups.status.map(render)}
        </section>
      )}
      {groups.more.length > 0 && (
        <div className="wb-block__more">
          <button
            type="button"
            className="wb-block__more-toggle"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(!moreOpen)}
          >
            <ChevronRight size={16} className="wb-block__more-chevron" />
            More
          </button>
          {moreOpen && <div className="wb-block__more-body">{groups.more.map(render)}</div>}
        </div>
      )}
    </div>
  );
}
