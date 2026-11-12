// @vitest-environment jsdom
//
// The shared cross-tool open helper: embedded it posts exactly the
// `canopy:trace-open` contract message to the parent, same-origin; standalone
// it opens the sibling `<tool>.html?<query>` in a new tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACE_OPEN, openTool, siblingToolUrl } from './openTool';

let post: ReturnType<typeof vi.spyOn>;
let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  open = vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('openTool embedded', () => {
  it('posts the canopy:trace-open contract message once, same-origin, and opens no tab', () => {
    window.history.replaceState(null, '', '/x/trace/correlation.html?embedded=true&x=A');
    openTool('waveform', 'pv=TEST:WF:1');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      { type: 'canopy:trace-open', tool: 'waveform', query: 'pv=TEST:WF:1' },
      window.location.origin
    );
    expect(TRACE_OPEN).toBe('canopy:trace-open');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('openTool standalone', () => {
  it('opens the sibling page with the query in a new tab and posts nothing', () => {
    window.history.replaceState(null, '', '/x/trace/correlation.html?x=A&y=B');
    openTool('waveform', 'pv=TEST:WF:1');
    expect(post).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target] = open.mock.calls[0] as [string, string];
    expect(url).toBe(`${window.location.origin}/x/trace/waveform.html?pv=TEST:WF:1`);
    expect(target).toBe('_blank');
  });

  it('embedded=false is standalone', () => {
    window.history.replaceState(null, '', '/x/trace/correlation.html?embedded=false');
    openTool('waveform', 'pv=A');
    expect(post).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('siblingToolUrl', () => {
  it('resolves next to the current page and drops its query and hash', () => {
    expect(siblingToolUrl('waveform', 'pv=A&pv=B', 'https://h/a/b/correlation.html?x=1#z')).toBe(
      'https://h/a/b/waveform.html?pv=A&pv=B'
    );
  });

  it('Trace is the index page', () => {
    expect(siblingToolUrl('trace', 'pv=A', 'https://h/a/waveform.html')).toBe(
      'https://h/a/index.html?pv=A'
    );
  });

  it('an empty query has no "?"', () => {
    expect(siblingToolUrl('waveform', '', 'https://h/a/index.html')).toBe(
      'https://h/a/waveform.html'
    );
  });
});
