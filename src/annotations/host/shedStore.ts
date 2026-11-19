// The shed store: how much of a plot's drawings its last published link
// could not carry. The plot's state-out publisher writes it after each encode;
// the drawing status line reads it ("N drawings not saved in the link", "Note
// text shortened in the link").

/** What the last encode shed: drawings dropped from the end, and notes whose text was trimmed. */
export interface ShedSnapshot {
  readonly dropped: number;
  readonly trimmed: number;
}

/** A tiny external store of the current {@link ShedSnapshot}. */
export interface ShedStore {
  /** The snapshot of the last change; the same object until the counts change. */
  get(): ShedSnapshot;
  /** Replace the counts. Equal counts keep the snapshot and notify no one. */
  publish(next: ShedSnapshot): void;
  /** Called after each change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
}

/** Nothing shed. */
export const NO_SHED: ShedSnapshot = Object.freeze({ dropped: 0, trimmed: 0 });

/**
 * A shed store starting at `initial` (nothing shed by default). `get()` is
 * stable between changes, so `useSyncExternalStore(store.subscribe, store.get)`
 * never loops; a publish of the same counts is a no-op.
 */
export function createShedStore(initial: ShedSnapshot = NO_SHED): ShedStore {
  let snapshot: ShedSnapshot =
    initial === NO_SHED
      ? NO_SHED
      : Object.freeze({ dropped: initial.dropped, trimmed: initial.trimmed });
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    publish(next) {
      if (next.dropped === snapshot.dropped && next.trimmed === snapshot.trimmed) return;
      snapshot = Object.freeze({ dropped: next.dropped, trimmed: next.trimmed });
      for (const cb of [...listeners]) cb();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
