// The latest render's value, for callbacks that run after the render that
// built them (an add committing after its async probe, a handle read between
// renders). Updated in a layout effect, so it is current by the time any
// event or effect fires; its identity never changes.

import { useLayoutEffect, useState } from 'react';

/** A stable holder of the latest committed render's value. */
export interface Latest<T> {
  readonly current: T;
}

class Holder<T> implements Latest<T> {
  current: T;

  constructor(value: T) {
    this.current = value;
  }

  set(value: T): void {
    this.current = value;
  }
}

/** The latest committed `value`, read through a holder whose identity is stable. */
export function useLatest<T>(value: T): Latest<T> {
  const [holder] = useState(() => new Holder(value));
  useLayoutEffect(() => holder.set(value));
  return holder;
}
