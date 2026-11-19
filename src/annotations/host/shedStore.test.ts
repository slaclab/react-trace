// Pins the shed store: starts at nothing shed, publish replaces the
// snapshot and notifies, equal counts are a no-op that keeps the reference
// (stable for useSyncExternalStore), and unsubscribe stops notifications.
import { describe, it, expect, vi } from 'vitest';
import { createShedStore, NO_SHED } from './shedStore';

describe('createShedStore', () => {
  it('starts with nothing shed', () => {
    const store = createShedStore();
    expect(store.get()).toEqual({ dropped: 0, trimmed: 0 });
    expect(store.get()).toBe(NO_SHED);
  });

  it('accepts an initial snapshot', () => {
    expect(createShedStore({ dropped: 2, trimmed: 1 }).get()).toEqual({ dropped: 2, trimmed: 1 });
  });

  it('publishes new counts and notifies every subscriber once', () => {
    const store = createShedStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.publish({ dropped: 3, trimmed: 0 });
    expect(store.get()).toEqual({ dropped: 3, trimmed: 0 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('keeps the same snapshot and notifies no one on equal counts', () => {
    const store = createShedStore();
    store.publish({ dropped: 1, trimmed: 2 });
    const before = store.get();
    const cb = vi.fn();
    store.subscribe(cb);
    store.publish({ dropped: 1, trimmed: 2 });
    expect(store.get()).toBe(before);
    expect(cb).not.toHaveBeenCalled();
  });

  it('returns a stable snapshot between changes, not the published object', () => {
    const store = createShedStore();
    const next = { dropped: 1, trimmed: 0 };
    store.publish(next);
    expect(store.get()).not.toBe(next);
    expect(store.get()).toBe(store.get());
    next.dropped = 9;
    expect(store.get().dropped).toBe(1);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createShedStore();
    const cb = vi.fn();
    const off = store.subscribe(cb);
    off();
    store.publish({ dropped: 0, trimmed: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('lets a listener unsubscribe while being notified', () => {
    const store = createShedStore();
    const later = vi.fn();
    const off = store.subscribe(() => off());
    store.subscribe(later);
    store.publish({ dropped: 1, trimmed: 0 });
    expect(later).toHaveBeenCalledTimes(1);
  });
});
