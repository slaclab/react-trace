// @vitest-environment jsdom
//
// The Sidebar's width, on the real
// react-resizable-panels: the design default is the panel's `defaultSize`, so
// the library's own separator double-click is the reset; the page's own width
// is applied once after mount without writing; the
// sidebar keeps its px width when the tile resizes and the page's width is
// re-applied (clamped, no write) on re-expand from the rail and when the tile
// widens; only a pointer-armed resize writes, and the arm clears on every
// pointerup/pointercancel in a frame after the library's commit.
//
// jsdom has no layout, so the harness gives the library one: a tile of
// `tileW` × `tileH` px, each panel's share following its flex-grow (the
// library's layout), rects laid out left to right, a ResizeObserver the test
// fires by hand, and animation frames the test flushes by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import {
  DEFAULT_ARRANGEMENT,
  type Arrangement,
  type ArrangementPatch,
  type ArrangementStore,
} from './arrangementStore';
import { SelectionProvider, createSelectionStore } from './selection';
import { SIDEBAR_TITLE, Sidebar } from './Sidebar';

// ---------------------------------------------------------------- harness --

interface FakeStore extends ArrangementStore {
  writes: ArrangementPatch[];
}

function fakeStore(initial: Partial<Arrangement> = {}): FakeStore {
  const writes: ArrangementPatch[] = [];
  return {
    key: 'test',
    initial: { ...DEFAULT_ARRANGEMENT, ...initial },
    writes,
    write: (patch) => writes.push(patch),
    flush: () => {},
    connect: () => () => {},
  };
}

let tileW = 1000;
const tileH = 600;

// --- animation frames, flushed by hand --------------------------------------

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function flushFrames() {
  act(() => {
    for (let round = 0; round < 5 && frames.size > 0; round++) {
      const due = [...frames.values()];
      frames = new Map();
      due.forEach((cb) => cb(performance.now()));
    }
  });
}

// --- ResizeObserver, fired by hand ------------------------------------------

const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver {
  targets = new Set<Element>();
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  fire(target: Element) {
    const width = offsetWidthOf(target as HTMLElement);
    const height = offsetHeightOf(target as HTMLElement);
    const entry = {
      target,
      contentRect: { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height },
      borderBoxSize: [{ inlineSize: width, blockSize: height }],
      contentBoxSize: [{ inlineSize: width, blockSize: height }],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

/** The tile (the horizontal group) takes a new width; every observer of it is told. */
function resizeTile(width: number) {
  tileW = width;
  act(() => {
    const group = widthGroup();
    for (const observer of [...observers]) {
      if (observer.targets.has(group)) observer.fire(group);
    }
  });
}

// --- layout ---------------------------------------------------------------

const isGroup = (el: Element | null): boolean =>
  el instanceof HTMLElement && el.hasAttribute('data-group') && el.style.flexDirection === 'row';

function growOf(el: HTMLElement): number {
  const grow = parseFloat(el.style.flexGrow);
  return Number.isFinite(grow) ? grow : 1;
}

/** A panel's share of `total`, by flex-grow among its sibling panels. */
function shareOf(el: HTMLElement, total: number): number {
  const siblings = Array.from(el.parentElement!.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute('data-panel')
  );
  const sum = siblings.reduce((acc, c) => acc + growOf(c), 0);
  return (growOf(el) / sum) * total;
}

function offsetWidthOf(el: HTMLElement): number {
  if (isGroup(el)) return tileW;
  if (el.hasAttribute('data-panel') && isGroup(el.parentElement)) return shareOf(el, tileW);
  return 0;
}

function offsetHeightOf(el: HTMLElement): number {
  if (isGroup(el)) return tileH;
  if (el.hasAttribute('data-panel') && isGroup(el.parentElement)) return tileH;
  return 0;
}

function box(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width: w,
    height: h,
    right: x + w,
    bottom: y + h,
    toJSON() {},
  } as DOMRect;
}

/** Children of the group laid out left to right; separators are 0 px at the boundary. */
function rectInGroup(el: HTMLElement, group: HTMLElement): DOMRect {
  let at = 0;
  for (const child of Array.from(group.children) as HTMLElement[]) {
    const size = child.hasAttribute('data-panel') ? offsetWidthOf(child) : 0;
    if (child === el) return box(at, 0, size, tileH);
    at += size;
  }
  return box(0, 0, 0, 0);
}

function rectOf(el: Element): DOMRect | null {
  if (!(el instanceof HTMLElement)) return null;
  if (isGroup(el)) return box(0, 0, tileW, tileH);
  const parent = el.parentElement;
  if ((el.hasAttribute('data-panel') || el.hasAttribute('data-separator')) && isGroup(parent)) {
    return rectInGroup(el, parent as HTMLElement);
  }
  return null;
}

/** The library orders a group's children by offsetLeft/offsetTop. */
function offsetAlong(el: HTMLElement, axis: 'x' | 'y'): number {
  const parent = el.parentElement;
  if (!isGroup(parent)) return 0;
  const rect = rectInGroup(el, parent as HTMLElement);
  return axis === 'x' ? rect.x : rect.y;
}

const STUBBED = ['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop'] as const;
const descriptors = Object.fromEntries(
  STUBBED.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
);
const stubs: Record<(typeof STUBBED)[number], (el: HTMLElement) => number> = {
  offsetWidth: offsetWidthOf,
  offsetHeight: offsetHeightOf,
  offsetLeft: (el) => offsetAlong(el, 'x'),
  offsetTop: (el) => offsetAlong(el, 'y'),
};

beforeEach(() => {
  tileW = 1000;
  frames = new Map();
  nextFrame = 1;
  observers.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  for (const name of STUBBED) {
    const stub = stubs[name];
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return stub(this);
      },
    });
  }
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this) ?? original.call(this);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of STUBBED) {
    const original = descriptors[name];
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
  }
});

function renderSidebar(store: FakeStore) {
  const utils = render(
    <SelectionProvider store={createSelectionStore()}>
      <Sidebar store={store} canvas={<div data-testid="canvas" />}>
        <p>properties</p>
      </Sidebar>
    </SelectionProvider>
  );
  flushFrames();
  return utils;
}

// --- queries ----------------------------------------------------------------

const widthGroup = () => document.querySelector<HTMLElement>('.wb-split')!;
const sidebarSlot = () => document.querySelector<HTMLElement>('[data-wb-slot="sidebar"]')!;
const edge = () => document.querySelector<HTMLElement>('.wb-split__edge')!;

/** The sidebar's width as the library laid it out. */
const sidebarPx = () => Math.round(offsetWidthOf(sidebarSlot()));

const widthWrites = (store: FakeStore) => store.writes.filter((w) => 'widthPx' in w);

// --- pointer gestures on a separator ----------------------------------------

const at = (x: number, y: number, buttons = 1) => ({
  clientX: x,
  clientY: y,
  button: 0,
  buttons,
  pointerId: 1,
  pointerType: 'mouse',
  isPrimary: true,
});

function press(el: HTMLElement, x: number, y: number) {
  act(() => {
    fireEvent.pointerDown(el, at(x, y));
  });
}
function moveTo(x: number, y: number) {
  act(() => {
    fireEvent.pointerMove(document, at(x, y));
  });
}
function release(el: HTMLElement, x: number, y: number) {
  act(() => {
    fireEvent.pointerUp(el, at(x, y, 0));
  });
}
function clickOn(el: HTMLElement, x: number, y: number) {
  press(el, x, y);
  release(el, x, y);
  act(() => {
    fireEvent.click(el, at(x, y, 0));
  });
}
/** Two clicks then `dblclick`, with no frame in between (as a browser delivers them). */
function doubleClickOn(el: HTMLElement, x: number, y: number) {
  clickOn(el, x, y);
  clickOn(el, x, y);
  act(() => {
    fireEvent.doubleClick(el, at(x, y, 0));
  });
}

// ------------------------------------------------------------------- width --

describe('sidebar width', () => {
  it('opens at the 300 px design default and writes nothing', () => {
    const store = fakeStore();
    renderSidebar(store);
    expect(sidebarPx()).toBe(300);
    expect(store.writes).toEqual([]);
  });

  it("applies the page's own width once after mount, without writing", () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    expect(sidebarPx()).toBe(400);
    expect(store.writes).toEqual([]);
  });

  it('a pointer drag on the edge writes the new width once', () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    press(edge(), 400, 10);
    moveTo(450, 10);
    moveTo(500, 10);
    release(edge(), 500, 10);
    flushFrames();
    expect(sidebarPx()).toBe(500);
    expect(store.writes).toEqual([{ widthPx: 500 }]);
  });

  it('a drag is held to the 220 px minimum and the 60 % maximum', () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    press(edge(), 400, 10);
    moveTo(900, 10);
    release(edge(), 900, 10);
    flushFrames();
    expect(sidebarPx()).toBe(600);
    press(edge(), 600, 10);
    moveTo(50, 10);
    release(edge(), 50, 10);
    flushFrames();
    expect(sidebarPx()).toBe(220);
    expect(widthWrites(store)).toEqual([{ widthPx: 600 }, { widthPx: 220 }]);
  });

  it('a click on the separator, then the tile shrinking, writes nothing', () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    clickOn(edge(), 400, 10);
    flushFrames();
    resizeTile(500);
    flushFrames();
    // The library did resize (to its 60 % maximum) — and nothing was written.
    expect(sidebarPx()).toBe(300);
    expect(store.writes).toEqual([]);
  });

  it('the arm clears on pointercancel as well', () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    press(edge(), 400, 10);
    act(() => {
      fireEvent.pointerCancel(edge(), at(400, 10, 0));
    });
    flushFrames();
    resizeTile(500);
    flushFrames();
    expect(sidebarPx()).toBe(300);
    expect(store.writes).toEqual([]);
  });

  it('the arm holds until the frame after pointerup (the commit is inside it)', () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    clickOn(edge(), 400, 10);
    // No frame yet: a layout change now still counts as the resize.
    resizeTile(500);
    expect(widthWrites(store)).toEqual([{ widthPx: 300 }]);
  });

  it('a double-click on the edge resets to the 300 px default and writes it once', () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    doubleClickOn(edge(), 400, 10);
    flushFrames();
    expect(sidebarPx()).toBe(300);
    expect(store.writes).toEqual([{ widthPx: 300 }]);
    // Later tile changes are not the reset's: nothing more is written.
    resizeTile(800);
    flushFrames();
    expect(store.writes).toEqual([{ widthPx: 300 }]);
  });

  it('a double-click at the default already changes and writes nothing', () => {
    const store = fakeStore();
    renderSidebar(store);
    doubleClickOn(edge(), 300, 10);
    flushFrames();
    expect(sidebarPx()).toBe(300);
    expect(store.writes).toEqual([]);
  });

  it("keeps its px width when the tile resizes; the page's width returns when it widens", () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    resizeTile(800);
    flushFrames();
    expect(sidebarPx()).toBe(400);
    resizeTile(500);
    flushFrames();
    expect(sidebarPx()).toBe(300); // clamped to 60 %
    resizeTile(1200);
    flushFrames();
    expect(sidebarPx()).toBe(400);
    expect(store.writes).toEqual([]);
  });

  it("the page's width written by a drag is the one re-applied when the tile widens", () => {
    const store = fakeStore({ widthPx: 400 });
    renderSidebar(store);
    press(edge(), 400, 10);
    moveTo(550, 10);
    release(edge(), 550, 10);
    flushFrames();
    resizeTile(700);
    flushFrames();
    expect(sidebarPx()).toBe(420);
    resizeTile(1000);
    flushFrames();
    expect(sidebarPx()).toBe(550);
    expect(widthWrites(store)).toEqual([{ widthPx: 550 }]);
  });

  it("re-expanding from the rail re-applies the page's width, clamped, without a width write", () => {
    const store = fakeStore({ widthPx: 400 });
    const { container } = renderSidebar(store);
    // The pane's collapse button collapses the sidebar to its rail.
    act(() => {
      fireEvent.click(
        container.querySelector(`.wb-sidebar__collapse[aria-label="Collapse ${SIDEBAR_TITLE}"]`)!
      );
    });
    expect(widthGroup().hasAttribute('data-wb-rail')).toBe(true);
    expect(edge().getAttribute('aria-disabled')).toBe('true');
    // While on the rail the tile narrows, then widens part way.
    resizeTile(500);
    flushFrames();
    resizeTile(700);
    flushFrames();
    act(() => {
      fireEvent.click(
        container.querySelector(`.wb-sidebar__rail-target[aria-label="Expand ${SIDEBAR_TITLE}"]`)!
      );
    });
    flushFrames();
    expect(widthGroup().hasAttribute('data-wb-rail')).toBe(false);
    expect(sidebarPx()).toBe(400);
    resizeTile(600);
    flushFrames();
    expect(sidebarPx()).toBe(360); // the page's 400 px, held to 60 %
    expect(widthWrites(store)).toEqual([]);
    expect(store.writes.every((w) => Object.keys(w).join() === 'collapsed')).toBe(true);
  });

  it('the canvas sits beside the sidebar, in the other panel', () => {
    const store = fakeStore();
    const { getByTestId } = renderSidebar(store);
    expect(getByTestId('canvas').closest('[data-wb-slot="canvas"]')).not.toBeNull();
    expect(Math.round(offsetWidthOf(document.querySelector('[data-wb-slot="canvas"]')!))).toBe(700);
  });
});
