// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  attachReadoutDrag,
  cornerAt,
  createReadoutDock,
  DOCK_INSET,
  DODGE_DWELL,
  freeCorner,
  projectionArea,
  READOUT_CLASS,
} from './readoutDock';

const GRID = { left: 70, top: 40, width: 600, height: 300 };
const BOX: [number, number] = [120, 50];
const size = { contentSize: [...BOX], viewSize: [760, 400] };

/** A dock over GRID with a clock the test moves. */
function dockAt() {
  const clock = { t: 0 };
  const dock = createReadoutDock({ grid: () => GRID, now: () => clock.t });
  const at = (x: number, y: number) => dock.position([x, y], null, null, null, size);
  return { dock, clock, at };
}

describe('readout dock placement', () => {
  it('docks inside the grid, inset from its edges, never over the axes', () => {
    expect(cornerAt('tl', BOX, GRID)).toEqual({ x: 70 + DOCK_INSET, y: 40 + DOCK_INSET });
    expect(cornerAt('br', BOX, GRID)).toEqual({
      x: 70 + 600 - DOCK_INSET - 120,
      y: 40 + 300 - DOCK_INSET - 50,
    });
  });

  it('starts in a corner whose column is clear of the cursor', () => {
    expect(freeCorner(100, 200, BOX, GRID)).toBe('tr');
    expect(freeCorner(600, 200, BOX, GRID)).toBe('tl');
  });

  it('stays put while the cursor only crosses its column', () => {
    const { clock, at } = dockAt();
    const start = at(600, 200); // top-left
    clock.t = 10;
    expect(at(100, 200)).toEqual(start); // into the column
    clock.t = 10 + DODGE_DWELL - 1;
    expect(at(600, 200)).toEqual(start); // out again before the dwell
    clock.t = 10_000;
    expect(at(110, 200)).toEqual(start); // back in: the dwell restarts
  });

  it('moves to the free corner across once the cursor rests under it', () => {
    const { clock, at } = dockAt();
    const start = at(600, 200);
    at(100, 200);
    clock.t = DODGE_DWELL;
    const moved = at(105, 200);
    expect(moved).not.toEqual(start);
    expect(moved).toEqual(Object.values(cornerAt('tr', BOX, GRID)));
  });

  it('takes the other edge when no corner of its own edge is clear', () => {
    const wide = { left: 0, top: 0, width: 200, height: 300 };
    // A box wider than half the grid covers the cursor's column in every corner.
    expect(freeCorner(100, 50, [150, 40], wide)).toBe('br');
    expect(freeCorner(100, 250, [150, 40], wide)).toBe('tr');
  });

  it('keeps the top-right corner while pinned', () => {
    const { dock, at } = dockAt();
    dock.setPinned(true);
    expect(at(600, 200)).toEqual(Object.values(cornerAt('tr', BOX, GRID)));
  });

  it('keeps a dropped place, inside the grid, until reset', () => {
    const { dock, at } = dockAt();
    expect(dock.drop(300, 120, BOX)).toEqual({ x: 300, y: 120 });
    expect(dock.moved()).toEqual([230, 80]);
    expect(at(320, 130)).toEqual([300, 120]);
    // Dropped past the edge: kept inside.
    expect(dock.drop(5000, -50, BOX)).toEqual({ x: 70 + 600 - 120, y: 40 });
    dock.reset();
    expect(dock.moved()).toBeNull();
    expect(at(600, 200)).toEqual(Object.values(cornerAt('tl', BOX, GRID)));
  });

  it('reads the plot area of every grid together', () => {
    const area = projectionArea({
      get: () => ({
        gridRect: { left: 10, top: 10, width: 100, height: 50 },
        grids: [
          { gridRect: { left: 10, top: 10, width: 100, height: 50 } },
          { gridRect: { left: 10, top: 80, width: 100, height: 50 } },
        ],
      }),
    });
    expect(area()).toEqual({ left: 10, top: 10, width: 100, height: 120 });
    expect(projectionArea({ get: () => null })()).toBeNull();
  });
});

describe('readout grip', () => {
  /** A chart dom holding a read-out box at (100, 50), 120 × 50. */
  function mount() {
    const container = document.createElement('div');
    const box = document.createElement('div');
    box.className = READOUT_CLASS;
    container.appendChild(box);
    document.body.appendChild(container);
    container.getBoundingClientRect = () => new DOMRect(0, 0, 760, 400);
    box.getBoundingClientRect = () => new DOMRect(100, 50, 120, 50);
    const dock = createReadoutDock({ grid: () => GRID });
    const detach = attachReadoutDrag(container, dock);
    const fire = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      box.dispatchEvent(e);
      return e;
    };
    return { container, box, dock, detach, fire };
  }

  it('drags the box by its grip and drops it where it is let go', () => {
    const { box, dock, detach, fire } = mount();
    fire('pointerdown', 105, 60);
    fire('pointermove', 205, 110);
    fire('pointerup', 205, 110);
    expect(dock.moved()).toEqual([200 - 70, 100 - 40]);
    expect(box.style.transform).toBe('translate3d(200px, 100px, 0px)');
    detach();
  });

  it('a press on the box body passes through to the plot and does not move the box', () => {
    const { container, dock, detach, fire } = mount();
    let reached = false;
    container.addEventListener('pointerdown', () => (reached = true));
    fire('pointerdown', 180, 60);
    fire('pointermove', 280, 110);
    expect(dock.moved()).toBeNull();
    expect(reached).toBe(true);
    detach();
  });

  it('a press on the grip never reaches the plot', () => {
    const { container, detach, fire } = mount();
    let reached = false;
    container.addEventListener('pointerdown', () => (reached = true));
    fire('pointerdown', 105, 60);
    expect(reached).toBe(false);
    fire('pointerup', 105, 60);
    detach();
  });

  it('holds still while the cursor is on it, so the grip can be reached', () => {
    const { clock, at } = dockAt();
    const start = at(600, 200); // top-left, box at (78, 48) 120 × 50
    clock.t = 0;
    at(85, 70);
    clock.t = 10 * DODGE_DWELL;
    expect(at(86, 71)).toEqual(start);
  });

  it('a double-click on the grip puts it back in its corner', () => {
    const { box, dock, detach, fire } = mount();
    dock.drop(300, 120, BOX);
    fire('dblclick', 104, 70);
    expect(dock.moved()).toBeNull();
    const tl = cornerAt('tl', [120, 50], GRID);
    expect(box.style.transform).toBe(`translate3d(${tl.x}px, ${tl.y}px, 0px)`);
    detach();
  });
});
