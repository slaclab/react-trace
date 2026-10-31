// The panel's memory of open/closed flags: a card's More disclosure, a
// plot-wide section, the chart source. One `OpenMemory` per panel, handed down
// through `OpenMemoryProvider` (FieldBlock.tsx), so a remount keeps the flags.

import { createContext, useCallback, useContext, useState } from 'react';

/** Open/closed flags that outlive the component showing them (one per panel). */
export class OpenMemory {
  private readonly open = new Map<string, boolean>();
  get(key: string, fallback: boolean): boolean {
    return this.open.get(key) ?? fallback;
  }
  set(key: string, value: boolean): void {
    this.open.set(key, value);
  }
}

export const OpenMemoryContext = createContext<OpenMemory | null>(null);

/** An open flag kept in the panel's memory under `key` (component state without one). */
export function useRememberedOpen(
  key: string,
  fallback: boolean
): [boolean, (open: boolean) => void] {
  const memory = useContext(OpenMemoryContext);
  const [open, setOpenState] = useState(() => memory?.get(key, fallback) ?? fallback);
  // A new key (another object in the same slot) reads its own memory.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setOpenState(memory?.get(key, fallback) ?? fallback);
  }
  const setOpen = useCallback(
    (next: boolean) => {
      memory?.set(key, next);
      setOpenState(next);
    },
    [memory, key]
  );
  return [open, setOpen];
}
