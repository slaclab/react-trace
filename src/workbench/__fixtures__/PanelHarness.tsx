// The properties panel as tests mount it: the top block (Outline) and the
// plot-wide sections (PlotSettings) of one tool, inside the caller's
// SelectionProvider. Every plot-wide section starts open unless `open` names
// the ones that should, so a test finds a tool-level field by its `#id`
// without clicking; a selected item's card is open as in the app.

import { useState, type ReactNode } from 'react';
import { OpenMemoryProvider } from '../FieldBlock';
import { OpenMemory } from '../openMemory';
import { Outline } from '../Outline';
import { PlotSettings } from '../PlotSettings';
import { plotSectionKey } from '../plotSettingsKeys';
import type { Capabilities, ToolDefinition, ToolUi } from '../types';

export interface PanelHarnessProps<S, M, U extends ToolUi = ToolUi> {
  definition: ToolDefinition<S, M, U>;
  state: S;
  model: M;
  ui: U;
  update(fn: (state: S) => S): void;
  capabilities: Capabilities;
  toolId?: string;
  catalog?: readonly string[];
  /** The plot-wide section ids open at mount; all of them when absent. */
  open?: readonly string[];
}

export function PanelHarness<S, M, U extends ToolUi = ToolUi>(
  props: PanelHarnessProps<S, M, U>
): ReactNode {
  const { definition, open, toolId = 'tool' } = props;
  const [memory] = useState(() => {
    const m = new OpenMemory();
    for (const tab of definition.schema.tool.tabs) {
      m.set(plotSectionKey(toolId, tab.id), open === undefined || open.includes(tab.id));
    }
    return m;
  });
  return (
    <div className="wb-panel">
      <OpenMemoryProvider memory={memory}>
        <Outline {...props} />
        <PlotSettings {...props} toolId={toolId} />
      </OpenMemoryProvider>
    </div>
  );
}
