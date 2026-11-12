// Trace's plot keymap: the generic key resolver bound to Trace's built-in
// drawing tools.
import { BUILTIN_CATALOG } from '../../../annotations/catalog';
import { resolveKeyIn, type KeyCommand, type KeyEventInput } from '../../../annotations/keys';
import { IS_MAC } from '../../../workbench/useCanvasActions';

/** The plot command `e` asks for in Trace, or `null`. Pure. */
export function resolveKey(e: KeyEventInput, mac: boolean = IS_MAC): KeyCommand | null {
  return resolveKeyIn(BUILTIN_CATALOG, e, mac) as KeyCommand | null;
}
