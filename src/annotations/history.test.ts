// Pins the drawing undo core: one ring entry per changed document,
// coalescing of a single drawing's consecutive writes within COALESCE_MS, the
// ring depth, the `undo`/`rehydrate` tags, an injected migration that is not
// an undo step, and the undo-key predicate that never treats a select or
// colour input as text entry.
import { describe, expect, it } from 'vitest';
import {
  COALESCE_MS,
  HISTORY_DEPTH,
  isTextEntryTarget,
  isUndoKey,
  type DrawingHistoryState,
  popDrawingHistory,
  withDrawingHistory,
} from './history';
import type { Annotation } from './model';

function ann(id: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: 0, v: 1 }],
    axisId: 'a1',
    color: 'c0',
    width: 1.5,
    text: '',
    ...extra,
  };
}

describe('the undo key', () => {
  const key = (extra: Partial<Parameters<typeof isUndoKey>[0]> = {}) => ({
    key: 'z',
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    ...extra,
  });

  it('is primary+Z: Ctrl off macOS, Cmd on macOS', () => {
    expect(isUndoKey(key(), false)).toBe(true);
    expect(isUndoKey(key({ key: 'Z' }), false)).toBe(true);
    expect(isUndoKey(key(), true)).toBe(false);
    expect(isUndoKey(key({ ctrlKey: false, metaKey: true }), true)).toBe(true);
  });

  it('skips shift (redo), alt, other keys and claimed events', () => {
    expect(isUndoKey(key({ shiftKey: true }), false)).toBe(false);
    expect(isUndoKey(key({ altKey: true }), false)).toBe(false);
    expect(isUndoKey(key({ key: 'y' }), false)).toBe(false);
    expect(isUndoKey(key({ defaultPrevented: true }), false)).toBe(false);
  });

  it('treats only text entry as editable', () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) =>
      ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
    expect(isTextEntryTarget(el('TEXTAREA'))).toBe(true);
    expect(isTextEntryTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    for (const type of [
      'text',
      'search',
      'number',
      'email',
      'url',
      'password',
      'tel',
      'date',
      'time',
    ]) {
      expect(isTextEntryTarget(el('INPUT', { type }))).toBe(true);
    }
    for (const type of ['color', 'checkbox', 'radio', 'button', 'range', 'submit']) {
      expect(isTextEntryTarget(el('INPUT', { type }))).toBe(false);
    }
    expect(isTextEntryTarget(el('SELECT'))).toBe(false);
    expect(isTextEntryTarget(el('BUTTON'))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isUndoKey(key({ target: el('INPUT', { type: 'text' }) }), false)).toBe(false);
    expect(isUndoKey(key({ target: el('SELECT') }), false)).toBe(true);
  });
});

// The generic core over documents of drawing lists, with no Plot.
interface DocApp extends DrawingHistoryState {
  docs: Record<string, Annotation[] | undefined>;
  settings: number;
}

function docApp(docs: Record<string, Annotation[] | undefined>): DocApp {
  return { docs, settings: 0, history: new Map() };
}

const docLists = (app: DocApp) => new Map(Object.entries(app.docs));

function writeDoc(app: DocApp, id: string, list: Annotation[]): DocApp {
  return { ...app, docs: { ...app.docs, [id]: list } };
}

describe('withDrawingHistory', () => {
  it('records a step only when a list identity changed', () => {
    const a = docApp({ d: [ann('x')] });
    const settings = { ...a, settings: 1 };
    expect(withDrawingHistory(a, settings, undefined, 0, docLists)).toBe(settings);
    const b = writeDoc(a, 'd', []);
    const out = withDrawingHistory(a, b, undefined, 0, docLists);
    expect(out.history.get('d')).toEqual([[ann('x')]]);
    expect(out.docs).toBe(b.docs);
  });

  it('treats an absent list as [] and skips a document that did not exist before', () => {
    const a = docApp({ d: undefined });
    const b = writeDoc(writeDoc(a, 'd', [ann('x')]), 'new', [ann('y')]);
    const out = withDrawingHistory(a, b, undefined, 0, docLists);
    expect(out.history.get('d')).toEqual([[]]);
    expect(out.history.has('new')).toBe(false);
  });

  it('skips tagged writes and the injected migration, which sees the document id and next state', () => {
    const a = docApp({ d: [ann('x')] });
    const b = writeDoc(a, 'd', [ann('x', { axisId: 'a2' })]);
    expect(withDrawingHistory(a, b, 'undo', 0, docLists)).toBe(b);
    expect(withDrawingHistory(a, b, 'rehydrate', 0, docLists)).toBe(b);
    const seen: string[] = [];
    const migration = (_p: Annotation[], _n: Annotation[], id: string, next: DocApp) => {
      seen.push(id);
      return next === b;
    };
    expect(withDrawingHistory(a, b, undefined, 0, docLists, migration)).toBe(b);
    expect(seen).toEqual(['d']);
  });

  it('coalesces within COALESCE_MS and caps each ring at HISTORY_DEPTH', () => {
    let app = docApp({ d: [ann('x')] });
    const s1 = withDrawingHistory(
      app,
      writeDoc(app, 'd', [ann('x', { text: '1' })]),
      undefined,
      0,
      docLists
    );
    const s2 = withDrawingHistory(
      s1,
      writeDoc(s1, 'd', [ann('x', { text: '2' })]),
      undefined,
      COALESCE_MS,
      docLists
    );
    expect(s2.history.get('d')).toHaveLength(1);
    app = s2;
    for (let i = 0; i < HISTORY_DEPTH + 5; i++) {
      app = withDrawingHistory(
        app,
        writeDoc(app, 'd', [...(app.docs.d ?? []), ann(`n${i}`)]),
        undefined,
        0,
        docLists
      );
    }
    expect(app.history.get('d')).toHaveLength(HISTORY_DEPTH);
  });
});

describe('popDrawingHistory', () => {
  const restore = (app: DocApp, list: Annotation[], id: string): DocApp | null =>
    id in app.docs ? writeDoc(app, id, list) : null;

  it('restores the newest entry through the injected writer and clears the mark', () => {
    const a = docApp({ d: [ann('x')] });
    const b = withDrawingHistory(
      a,
      writeDoc(a, 'd', [ann('x', { text: 't' })]),
      undefined,
      0,
      docLists
    );
    expect(b.annotationMark).not.toBeNull();
    const out = popDrawingHistory(b, 'd', restore);
    expect(out.docs.d).toEqual([ann('x')]);
    expect(out.history.get('d')).toEqual([]);
    expect(out.annotationMark).toBeNull();
  });

  it('returns the state itself when the ring is empty or the writer reports the document gone', () => {
    const a = docApp({ d: [ann('x')] });
    expect(popDrawingHistory(a, 'd', restore)).toBe(a);
    const gone = { ...a, docs: {}, history: new Map([['d', [[ann('x')]]]]) };
    expect(popDrawingHistory(gone, 'd', restore)).toBe(gone);
  });
});
