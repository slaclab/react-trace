// The standard actions' inputs, the same for every tool: the embedded and
// host-bar flags read once per mount (`workbench/embedding.ts`), the theme
// toggle standalone only (embedded, the host owns the theme: no toggle and no
// shortcut), and the app's links. The bug-report and docs links are defined
// here once, for every tool.

import { useMemo } from 'react';
import { isEmbedded } from '../embed/embedded';
import { toggleColorMode, type ColorMode } from '@slaclab/canopy-shell/color-mode';
import { hostBarPage } from '../workbench/embedding';
import type { StandardActionsOptions } from '../workbench/standardActions';

export const BUG_REPORT_URL = 'https://forms.office.com/r/qV7BmK2xi9';
export const DOCS_URL = 'https://fuzzy-adventure-4qvly8m.pages.github.io/';

/** What a tool's action list passes on to `standardActions`, for the current colour mode. */
export function useStandardActionsOptions(colorMode: ColorMode): StandardActionsOptions {
  const embedded = useMemo(() => isEmbedded(), []);
  const hostBar = useMemo(() => hostBarPage(), []);
  return {
    embedded,
    hostBar,
    theme: embedded ? undefined : { colorMode, toggle: toggleColorMode },
    bugUrl: BUG_REPORT_URL,
    docsUrl: DOCS_URL,
  };
}
