import { useEffect, useState } from 'react';

const FRAME_MS = 16;
// Used when the plot's width isn't known yet (or in jsdom, which reports 0).
const FALLBACK_WIDTH_PX = 800;
const MIN_WIDTH_PX = 100;

// How often a following plot's axis needs to move to stay smooth: about once
// per screen pixel of its time span, but no faster than one animation frame. A
// 30 s span over 800 px steps every ~37 ms; a 1 h span only every ~4.5 s.
export function followStepMs(spanMs: number, widthPx: number): number {
  const px = widthPx > 0 ? Math.max(widthPx, MIN_WIDTH_PX) : FALLBACK_WIDTH_PX;
  return Math.max(FRAME_MS, spanMs / px);
}

export interface FollowNowOptions {
  // Whether the plot is tracking "now" (see isFollowing).
  following: boolean;
  // Where the axis ends without scrolling (see axisEndMs). The display never
  // runs behind it.
  anchorMs: number;
  // Length of the plot's time range in ms.
  spanMs: number;
  // Window whose animation frames drive the display: the chart's own window, so
  // a plot detached into another window keeps scrolling while the main one is
  // hidden. Must be a stable callback.
  getWindow: () => Window | null;
  // Width of the plot area in px. Must be a stable callback.
  getWidthPx: () => number;
}

// Display "now" for a following plot's time axis. The plot's clock only
// advances once per refresh interval, which on a short span is a visible jump
// (a 5 s tick is a sixth of a 30 s window). While following, this advances the
// axis on animation frames, about once per pixel, so it scrolls smoothly
// regardless of how often samples arrive. It only moves the axis: fetch windows
// stay on the clock. Returns `anchorMs` while not following.
export function useFollowNow({
  following,
  anchorMs,
  spanMs,
  getWindow,
  getWidthPx,
}: FollowNowOptions): number {
  // Wall time of the last frame step; -Infinity until the first, so the display
  // is `anchorMs` until then (seeding it with an anchor that was a live sample
  // ahead of the clock would hold the axis there).
  const [frameMs, setFrameMs] = useState(-Infinity);

  useEffect(() => {
    if (!following) return;
    const win = getWindow();
    if (!win || typeof win.requestAnimationFrame !== 'function') return;
    let raf = 0;
    let lastMs = -Infinity;
    const step = () => {
      const now = Date.now();
      if (now - lastMs >= followStepMs(spanMs, getWidthPx())) {
        lastMs = now;
        setFrameMs(now);
      }
      raf = win.requestAnimationFrame(step);
    };
    raf = win.requestAnimationFrame(step);
    return () => win.cancelAnimationFrame(raf);
  }, [following, spanMs, getWindow, getWidthPx]);

  // A resume re-anchors the clock at the current time, so the max shows it
  // immediately instead of a stale frame from before the plot froze.
  return following ? Math.max(frameMs, anchorMs) : anchorMs;
}
