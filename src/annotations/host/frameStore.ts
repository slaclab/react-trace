// The frame store: a version counter the plot bumps on each new data
// frame. Only the measure card subscribes, so a frame re-renders the card and
// nothing else. Every host builds its `HostConfig.frames` from this one.
import type { FrameStore } from '../catalog/types';

/** A frame store the plot bumps on each new data frame. */
export interface BumpableFrameStore extends FrameStore {
  bump(): void;
}

export function createFrameStore(): BumpableFrameStore {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    getVersion: () => version,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    bump() {
      version += 1;
      for (const cb of [...listeners]) cb();
    },
  };
}
