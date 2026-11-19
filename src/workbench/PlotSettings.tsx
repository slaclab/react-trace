// The plot-wide half of the properties panel: the
// tool-level field groups as collapsible sections, then the chart source.
//
// - One section per tool-level tab except `code`, in declared order (the
//   tools declare Acquisition, Axes, Display, Statistics). The whole header is
//   the toggle; closed, it shows the tab's one-line `summary`. Every section
//   starts closed; its open state is remembered per tool and section id for as
//   long as the panel lives.
// - The Axes section (tab id `axes`) also holds the fields of every section
//   with `placement: 'axes'` (Trace's Y axes), one sub-block per section,
//   titled with its name and unit, with `ctx.target` set to that section.
// - Selecting such a section (the canvas, a test) opens Axes and scrolls its
//   sub-block into view, marked `wb-axes-block--selected`.
// - The tool-level tab `code` is the one "Show chart source" link: its
//   fields render below it while it is open.
// - `ctx.target` is the tool level for the plot-wide fields.

import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronRight, Code } from '@carbon/icons-react';
import { Field } from './fields';
import { FieldBlock } from './FieldBlock';
import { useRememberedOpen } from './openMemory';
import { AXES_TAB, CODE_TAB, plotSectionKey } from './plotSettingsKeys';
import { resolveSelection, useWorkbenchSelection } from './selection';
import type {
  Capabilities,
  OutlineSection,
  TabDef,
  Target,
  ToolContext,
  ToolDefinition,
  ToolUi,
} from './types';

export interface PlotSettingsProps<S, M, U extends ToolUi = ToolUi> {
  definition: ToolDefinition<S, M, U>;
  state: S;
  model: M;
  ui: U;
  /** The tool's single writer, handed to every field as `ctx.update`. */
  update(fn: (state: S) => S): void;
  capabilities: Capabilities;
  /** The tool-level target's kind and id (`ctx.target` of the plot-wide fields). */
  toolId?: string;
}

interface SectionProps {
  id: string;
  title: string;
  summary: string;
  memoryKey: string;
  /** Opened from outside (a selected axis); the user's toggle still wins after. */
  reveal: boolean;
  children: ReactNode;
}

function PlotSection({ id, title, summary, memoryKey, reveal, children }: SectionProps) {
  const [open, setOpen] = useRememberedOpen(memoryKey, false);
  useEffect(() => {
    if (reveal && !open) setOpen(true);
    // Only a new reveal opens it; closing it afterwards is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  return (
    <section className={`wb-plot-section${open ? ' wb-plot-section--open' : ''}`} data-section={id}>
      <button
        type="button"
        className="wb-plot-section__head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={16} className="wb-plot-section__chevron" />
        <span className="wb-plot-section__title">{title}</span>
        {summary !== '' && <span className="wb-plot-section__summary">{summary}</span>}
      </button>
      {open && <div className="wb-plot-section__body">{children}</div>}
    </section>
  );
}

function ChartSource<S, M, U extends ToolUi>({
  tab,
  ctx,
  memoryKey,
}: {
  tab: TabDef<S, M, U>;
  ctx: ToolContext<S, M, U>;
  memoryKey: string;
}) {
  const [open, setOpen] = useRememberedOpen(memoryKey, false);
  return (
    <div className="wb-plot__source">
      <button
        type="button"
        className="wb-plot__source-link"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Code size={16} />
        {open ? 'Hide chart source' : 'Show chart source'}
      </button>
      {open && (
        <div className="wb-plot__source-body">
          {tab.fields.map((field) => (
            <Field key={field.id} field={field} ctx={ctx} placement="properties" />
          ))}
        </div>
      )}
    </div>
  );
}

function AxesBlock<S, M, U extends ToolUi>({
  section,
  tabs,
  ctx,
  selected,
  idSuffix,
}: {
  section: OutlineSection;
  tabs: TabDef<S, M, U>[];
  ctx: ToolContext<S, M, U>;
  selected: boolean;
  /** Keeps `#id`s unique when several sections share the block (`--<section id>`). */
  idSuffix?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <div
      ref={ref}
      className={`wb-axes-block${selected ? ' wb-axes-block--selected' : ''}`}
      data-axes-section={section.id}
    >
      <h4 className="wb-axes-block__heading">
        <span>{section.title}</span>
        {section.unit !== undefined && section.unit !== '' && (
          <span className="wb-axes-block__unit">{section.unit}</span>
        )}
      </h4>
      {tabs.map((tab) => (
        <FieldBlock
          key={tab.id}
          block={tab}
          ctx={ctx}
          memoryKey={`section:${section.kind}:${tab.id}`}
          idSuffix={idSuffix}
        />
      ))}
    </div>
  );
}

export function PlotSettings<S, M, U extends ToolUi = ToolUi>({
  definition,
  state,
  model,
  ui,
  update,
  capabilities,
  toolId = 'tool',
}: PlotSettingsProps<S, M, U>): ReactNode {
  const { selection: raw } = useWorkbenchSelection();
  const { schema, binding } = definition;
  const outline = binding.outline(state, model);
  const selection = resolveSelection(outline, raw);
  const ctxFor = (target: Target): ToolContext<S, M, U> => ({
    state,
    model,
    update,
    selection,
    target,
    capabilities,
    ui,
  });
  const toolCtx = ctxFor({ level: 'tool', kind: toolId, id: toolId });

  const axesSections = outline.sections.filter(
    (s) => schema.sections[s.kind]?.placement === 'axes'
  );
  const selectedAxes =
    selection?.level === 'section' && axesSections.some((s) => s.id === selection.id)
      ? selection.id
      : null;
  const sections = schema.tool.tabs.filter((tab) => tab.id !== CODE_TAB);
  const code = schema.tool.tabs.find((tab) => tab.id === CODE_TAB);

  return (
    <div className="wb-plot" aria-label="Plot settings">
      {sections.map((tab) => (
        <PlotSection
          key={tab.id}
          id={tab.id}
          title={tab.label}
          summary={tab.summary?.(toolCtx) ?? ''}
          memoryKey={plotSectionKey(toolId, tab.id)}
          reveal={tab.id === AXES_TAB && selectedAxes !== null}
        >
          <FieldBlock block={tab} ctx={toolCtx} memoryKey={`tool:${tab.id}`} />
          {tab.id === AXES_TAB &&
            axesSections.map((section, index) => (
              <AxesBlock
                key={section.id}
                section={section}
                idSuffix={index === 0 ? undefined : `--${section.id}`}
                tabs={(schema.sections[section.kind]?.tabs ?? []).filter((t) => t.id !== CODE_TAB)}
                ctx={ctxFor({ level: 'section', kind: section.kind, id: section.id })}
                selected={selectedAxes === section.id}
              />
            ))}
        </PlotSection>
      ))}
      {code !== undefined && (
        <ChartSource tab={code} ctx={toolCtx} memoryKey={plotSectionKey(toolId, CODE_TAB)} />
      )}
    </div>
  );
}
