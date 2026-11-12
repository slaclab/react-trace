// Backend doubles shared by the Playwright specs: Hare and the Formula Engine as mocked
// WebSockets (`page.routeWebSocket`), Mole as mocked HTTP (`page.route`).
// `vite preview` inherits the dev proxy, so every spec mocks what its page
// opens; nothing here connects to a server — the route handler is the server.
//
// What each double keeps of the real service:
//   - Hare answers every non-empty `subscribe` with one `initial` (connected)
//     and every `ping` with a `pong`. The SDK client pings every 15 s and
//     closes a socket that stays silent for 10 s after it, so a page kept open
//     longer than 25 s needs the pong. PV names in `hold` are left out of every
//     `initial`: they stay unverified, as a PV the gateway never connects. A PV
//     is scalar (value 0) unless `waveforms` names it: then its `initial`
//     carries `valueKind: 'waveform'` and an array, and once subscribed it
//     streams `diff` frames at its rate, each send recorded with the time it
//     was scheduled for and the time it went out, on the host clock (the test
//     process's `Date.now()`), so a perf spec can time a frame end to end.
//   - the Formula Engine acknowledges table subscribes and sends nothing else — in particular
//     no `pong`: the render benchmark counts every raw message on this socket,
//     and a pong would be a stray one. A spec that keeps a page open past 25 s
//     sees the Formula Engine socket drop and resubscribe.
//   - Formula Engine REST (`mockFormulaEngineRest`) answers the validate and evaluate POSTs the
//     CANOPY host relays to an embedded page: every expression is
//     valid, and an evaluation returns a fixed number of points evenly inside
//     the requested window. Each request body is recorded.
//   - Mole knows one PV, `SIM:TEST`, and answers its data request with raw
//     samples inside the requested window, whatever binning was asked for (the
//     page branches on the answer's `mode`). Any other PV is a 404 envelope.
//
// Matching is by URL path, not origin, so the doubles also work under a
// gateway prefix. Routes registered later win: install these after a spec's
// own catch-all for `/mole`, `/hare` and `/formula-engine`.

import type { Page, Route, WebSocketRoute } from '@playwright/test';

export const FORMULA_ENGINE_PATH = '/formula-engine/v1/ws/formulas';
export const HARE_PATH = '/hare/v1/ws/pvs';
const MOLE_PREFIX = '/mole/v1/';

/** Matches a URL by the end of its path. */
export function pathEndsWith(path: string): (url: URL) => boolean {
  return (url) => url.pathname.endsWith(path);
}

// ── Mocked Hare ─────────────────────────────────────────────────────────────

/** Unit reported for a PV the caller's `units` does not cover. */
const DEFAULT_UNITS = 'mm';

/** One waveform element; `null` is a dead element (the canvas draws a gap). */
export type HareElement = number | null;

/** How a waveform PV is served. */
export interface HareWaveform {
  /** Elements per frame. */
  length: number;
  /** Frames per second once subscribed; 0 sends the `initial` only. */
  hz: number;
  /**
   * Element `i` of frame `frame` (0 is the `initial`); a slow sine moving one
   * element per frame by default.
   */
  value?: (i: number, frame: number) => HareElement;
  /** Elements sent as `null` in every frame, whatever `value` says. */
  nulls?: readonly number[];
}

/** One frame the mock sent for a waveform PV. */
export interface HareFrameRecord {
  pv: string;
  /** 0 for the `initial`, then one per periodic frame. */
  frame: number;
  /** When the frame was due, host clock (ms since the epoch). */
  scheduledAt: number;
  /** When `send` was called, host clock (ms since the epoch). */
  sentAt: number;
  connected: boolean;
}

export interface HareMockOptions {
  /** PV names that never receive an `initial` frame. */
  hold?: Set<string>;
  /** Unit per PV; one unit for every PV when omitted. */
  units?: (pv: string) => string | null;
  /** PVs served as waveforms, by name; every other PV is scalar. */
  waveforms?: Record<string, HareWaveform>;
}

export interface HareMock {
  /** Every waveform frame sent, in send order (the perf spec reads this). */
  readonly frames: readonly HareFrameRecord[];
  /** Change how a waveform PV is served from its next frame on. */
  setWaveform(pv: string, patch: Partial<HareWaveform>): void;
  /**
   * Send one frame of `pv` now, outside its schedule (`initial` excluded), so
   * a spec need not wait for the next period.
   */
  sendFrame(pv: string): void;
  /** `pv` goes disconnected (one `connected: false` diff); its stream pauses. */
  disconnect(pv: string): void;
  /** `pv` comes back: a connected frame at once, then its stream resumes. */
  reconnect(pv: string): void;
  /** Stop every stream (call when the spec ends; closing the page also stops them). */
  stop(): void;
}

const META_NULLS = {
  precision: 4,
  description: null,
  enumChoices: null,
  displayLow: null,
  displayHigh: null,
  controlLow: null,
  controlHigh: null,
  warningLow: null,
  warningHigh: null,
  alarmLow: null,
  alarmHigh: null,
  writable: false,
  form: null,
};

function defaultElement(i: number, frame: number): number {
  return Math.sin((i + frame) / 8);
}

/** The array of frame `frame` of `spec`. */
export function waveformValue(spec: HareWaveform, frame: number): HareElement[] {
  const value = spec.value ?? defaultElement;
  const out: HareElement[] = Array.from({ length: spec.length }, (_, i) => value(i, frame));
  for (const i of spec.nulls ?? []) if (i >= 0 && i < out.length) out[i] = null;
  return out;
}

/** Milliseconds between frames; infinite for a PV that sends its `initial` only. */
function periodOf(spec: HareWaveform): number {
  return spec.hz > 0 ? 1000 / spec.hz : Number.POSITIVE_INFINITY;
}

function hareDto(
  pv: string,
  value: unknown,
  valueKind: string,
  connected: boolean
): Record<string, unknown> {
  return {
    pv,
    value: connected ? value : null,
    valueKind,
    severity: connected ? 'NO_ALARM' : 'INVALID',
    tsNs: Date.now() * 1_000_000,
    connected,
    error: connected ? null : 'disconnected',
  };
}

export async function mockHare(page: Page, options: HareMockOptions = {}): Promise<HareMock> {
  const hold = options.hold ?? new Set<string>();
  const units = options.units ?? (() => DEFAULT_UNITS);
  const specs = new Map<string, HareWaveform>(Object.entries(options.waveforms ?? {}));
  const frames: HareFrameRecord[] = [];

  /** Per waveform PV: the next frame number, its schedule and its connection. */
  interface Stream {
    next: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** When the next frame is due (host clock, ms). */
    due: number;
    connected: boolean;
  }
  const streams = new Map<string, Stream>();
  /** The latest socket and the PVs subscribed on it. */
  let socket: WebSocketRoute | null = null;
  let subscribed = new Set<string>();
  let stopped = false;

  const trySend = (text: string): boolean => {
    if (socket === null || stopped) return false;
    try {
      socket.send(text);
      return true;
    } catch {
      return false; // The page closed the socket under us.
    }
  };

  const sendWaveform = (pv: string, scheduledAt: number): void => {
    const spec = specs.get(pv);
    const stream = streams.get(pv);
    if (spec === undefined || stream === undefined || !subscribed.has(pv)) return;
    const frame = stream.next++;
    const dto = hareDto(pv, waveformValue(spec, frame), 'waveform', stream.connected);
    const sentAt = Date.now();
    if (trySend(JSON.stringify({ type: 'diff', data: { [pv]: dto } }))) {
      frames.push({ pv, frame, scheduledAt, sentAt, connected: stream.connected });
    }
  };

  const unschedule = (stream: Stream): void => {
    if (stream.timer !== null) clearTimeout(stream.timer);
    stream.timer = null;
  };

  // Frames are due on a fixed grid from the stream's start, so a late timer
  // does not push every later frame back (the record keeps the lateness).
  const schedule = (pv: string): void => {
    const spec = specs.get(pv);
    const stream = streams.get(pv);
    if (spec === undefined || stream === undefined) return;
    unschedule(stream);
    if (stopped || spec.hz <= 0 || !stream.connected || !subscribed.has(pv)) return;
    const period = periodOf(spec);
    const now = Date.now();
    while (stream.due <= now - period) stream.due += period; // skip frames missed wholesale
    stream.timer = setTimeout(
      () => {
        stream.timer = null;
        const at = stream.due;
        stream.due += period;
        sendWaveform(pv, at);
        schedule(pv);
      },
      Math.max(0, stream.due - now)
    );
  };

  const hareInitial = (pvNames: string[]): string => {
    const tsNs = Date.now() * 1_000_000;
    const data: Record<string, unknown> = {};
    const meta: Record<string, unknown> = {};
    for (const pv of pvNames) {
      const spec = specs.get(pv);
      const valueKind = spec === undefined ? 'scalar' : 'waveform';
      let value: unknown = 0;
      if (spec !== undefined) {
        // A (re)subscribe starts the PV's stream afresh at frame 0.
        const old = streams.get(pv);
        if (old !== undefined) unschedule(old);
        streams.set(pv, {
          next: 1,
          timer: null,
          due: Date.now() + periodOf(spec),
          connected: true,
        });
        value = waveformValue(spec, 0);
      }
      data[pv] = { ...hareDto(pv, value, valueKind, true), tsNs };
      meta[pv] = { pv, valueKind, units: units(pv), ...META_NULLS };
    }
    return JSON.stringify({ type: 'initial', data, meta, count: pvNames.length });
  };

  await page.routeWebSocket(pathEndsWith(HARE_PATH), (ws) => {
    // A reconnecting client opens a fresh socket: it subscribes afresh.
    for (const stream of streams.values()) unschedule(stream);
    socket = ws;
    subscribed = new Set();
    ws.onClose(() => {
      if (socket !== ws) return;
      for (const stream of streams.values()) unschedule(stream);
      socket = null;
    });
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; pvNames?: string[] };
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }
      if (!msg.pvNames) return;
      if (msg.type === 'unsubscribe') {
        for (const pv of msg.pvNames) {
          subscribed.delete(pv);
          const stream = streams.get(pv);
          if (stream !== undefined) unschedule(stream);
        }
        return;
      }
      if (msg.type !== 'subscribe') return;
      // One subscribe frame can carry held and answered names together.
      const answered = msg.pvNames.filter((pv) => !hold.has(pv));
      for (const pv of answered) subscribed.add(pv);
      if (answered.length === 0) return;
      ws.send(hareInitial(answered));
      const sentAt = Date.now();
      for (const pv of answered) {
        if (!specs.has(pv)) continue;
        frames.push({ pv, frame: 0, scheduledAt: sentAt, sentAt, connected: true });
        schedule(pv);
      }
    });
  });

  return {
    frames,
    setWaveform(pv, patch) {
      const spec = specs.get(pv);
      if (spec === undefined) throw new Error(`mockHare: ${pv} is not a waveform PV`);
      specs.set(pv, { ...spec, ...patch });
      if (patch.hz !== undefined) {
        const stream = streams.get(pv);
        if (stream !== undefined) stream.due = Date.now() + periodOf(specs.get(pv)!);
        schedule(pv);
      }
    },
    sendFrame(pv) {
      sendWaveform(pv, Date.now());
    },
    disconnect(pv) {
      const stream = streams.get(pv);
      if (stream === undefined) throw new Error(`mockHare: ${pv} has not been subscribed`);
      unschedule(stream);
      stream.connected = false;
      sendWaveform(pv, Date.now());
    },
    reconnect(pv) {
      const stream = streams.get(pv);
      if (stream === undefined) throw new Error(`mockHare: ${pv} has not been subscribed`);
      stream.connected = true;
      const now = Date.now();
      sendWaveform(pv, now);
      stream.due = now + periodOf(specs.get(pv)!);
      schedule(pv);
    },
    stop() {
      stopped = true;
      for (const stream of streams.values()) unschedule(stream);
    },
  };
}

// ── Mocked Formula Engine ─────────────────────────────────────────────────────

export interface FormulaEngineSubscription {
  ws: WebSocketRoute;
  serverId: string;
  columns: string[];
  bindings: string[];
}

export interface FormulaEngineMock {
  /** Resolves with the first table subscription the page sends. */
  subscribed: Promise<FormulaEngineSubscription>;
}

export async function mockFormulaEngine(page: Page): Promise<FormulaEngineMock> {
  let resolve!: (sub: FormulaEngineSubscription) => void;
  const subscribed = new Promise<FormulaEngineSubscription>((r) => (resolve = r));
  let counter = 0;
  await page.routeWebSocket(pathEndsWith(FORMULA_ENGINE_PATH), (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as {
        type: string;
        spec?: {
          kind?: string;
          columns?: Record<string, string>;
          bindings?: Record<string, string>;
        };
      };
      if (msg.type !== 'subscribe' || msg.spec?.kind !== 'table') return;
      const serverId = `mock-${++counter}`;
      ws.send(JSON.stringify({ type: 'subscribed', id: serverId }));
      resolve({
        ws,
        serverId,
        columns: Object.keys(msg.spec.columns ?? {}),
        bindings: Object.keys(msg.spec.bindings ?? {}),
      });
    });
  });
  return { subscribed };
}

// ── Mocked Formula Engine REST ────────────────────────────────────────────────────

export const FORMULA_ENGINE_VALIDATE_PATH = '/formula-engine/v1/validate';
export const FORMULA_ENGINE_EVALUATE_PATH = '/formula-engine/v1/evaluate';
/** Points per evaluate answer, evenly spaced inside the requested window. */
export const FORMULA_ENGINE_EVALUATE_POINTS = 7;

/** The formula spec as the page sends it (bindings resolved to PV names). */
export interface FormulaEngineRestSpec {
  kind: string;
  expression: string;
  bindings: Record<string, string>;
}

export interface FormulaEngineRestMock {
  /** Every validate POST body, in arrival order. */
  readonly validated: readonly FormulaEngineRestSpec[];
  /** Every evaluate POST body, in arrival order. */
  readonly evaluated: readonly { spec: FormulaEngineRestSpec; t0Ns: number; t1Ns: number }[];
}

function formulaEngineTimeseries(t0Ns: number, t1Ns: number): unknown {
  const to = t1Ns > 0 ? t1Ns : Date.now() * 1_000_000;
  const step = (to - t0Ns) / (FORMULA_ENGINE_EVALUATE_POINTS + 1);
  const tsNs = Array.from({ length: FORMULA_ENGINE_EVALUATE_POINTS }, (_, i) =>
    Math.round(t0Ns + (i + 1) * step)
  );
  return {
    kind: 'timeseries',
    timeseries: {
      tsNs,
      values: tsNs.map((_, i) => 2 + Math.cos(i / 2)),
      severity: tsNs.map(() => 'NO_ALARM'),
      inputs: {},
      decimated: false,
    },
  };
}

/**
 * the Formula Engine's validate and evaluate POSTs, as the host relays them. Matched by path
 * end, so it works under a gateway prefix; install after a catch-all for
 * `/formula-engine` (later routes win). Any other method on these paths is a 405.
 */
export async function mockFormulaEngineRest(page: Page): Promise<FormulaEngineRestMock> {
  const validated: FormulaEngineRestSpec[] = [];
  const evaluated: { spec: FormulaEngineRestSpec; t0Ns: number; t1Ns: number }[] = [];
  await page.route(pathEndsWith(FORMULA_ENGINE_VALIDATE_PATH), (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 405 });
    const spec = route.request().postDataJSON() as FormulaEngineRestSpec;
    validated.push(spec);
    return route.fulfill({ json: { valid: true, tokens: [], errors: [] } });
  });
  await page.route(pathEndsWith(FORMULA_ENGINE_EVALUATE_PATH), (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 405 });
    const body = route.request().postDataJSON() as {
      spec: FormulaEngineRestSpec;
      t0Ns: number;
      t1Ns: number;
    };
    evaluated.push(body);
    return route.fulfill({ json: formulaEngineTimeseries(body.t0Ns, body.t1Ns) });
  });
  return { validated, evaluated };
}

// ── Mocked Mole ─────────────────────────────────────────────────────────────

/** The one PV the mocked archiver holds. */
export const MOLE_PV = 'SIM:TEST';
const MOLE_ARCHIVER = 'mock';
/** Samples per data answer, evenly spaced over the requested window. */
const MOLE_SAMPLES = 60;
/** Window used when a data request names no `from`. */
const MOLE_DEFAULT_WINDOW_NS = 600 * 1_000_000_000;

function moleError(route: Route, status: number, code: string, detail: string): Promise<void> {
  return route.fulfill({ status, json: { code, detail } });
}

function moleData(pv: string, archiver: string, query: URLSearchParams): unknown {
  const nowNs = Date.now() * 1_000_000;
  const to = Number(query.get('to') ?? nowNs);
  const from = Number(query.get('from') ?? to - MOLE_DEFAULT_WINDOW_NS);
  const step = (to - from) / (MOLE_SAMPLES + 1);
  const samples = Array.from({ length: MOLE_SAMPLES }, (_, i) => ({
    tsNs: Math.round(from + (i + 1) * step),
    value: 1 + Math.sin(i / 5),
    severity: 'NO_ALARM',
    source: 'archive',
  }));
  return { mode: 'raw', pv, archiver, from, to, decimated: false, samples };
}

function moleMetadata(pv: string, archiver: string): unknown {
  return {
    pv,
    archiver,
    description: 'Mocked archive PV',
    units: 'mA',
    precision: 3,
    displayLow: null,
    displayHigh: null,
    alarmLow: null,
    alarmHigh: null,
    warningLow: null,
    warningHigh: null,
  };
}

export async function mockMole(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.includes(MOLE_PREFIX),
    (route) => {
      const url = new URL(route.request().url());
      const tail = url.pathname.slice(url.pathname.indexOf(MOLE_PREFIX) + MOLE_PREFIX.length);
      const [resource, ...rest] = tail.split('/');
      const pv = decodeURIComponent(rest.join('/'));
      const archiver = url.searchParams.get('archiver') ?? MOLE_ARCHIVER;

      if (resource === 'archivers') {
        return route.fulfill({
          json: {
            default: MOLE_ARCHIVER,
            archivers: [
              {
                name: MOLE_ARCHIVER,
                typeName: 'mock',
                url: 'mock://archiver',
                healthy: true,
                latencyMs: 0,
                lastError: null,
              },
            ],
          },
        });
      }
      if (resource === 'search') {
        const pattern = url.searchParams.get('pattern') ?? '';
        const needle = pattern.replaceAll('*', '').toLowerCase();
        const pvs = MOLE_PV.toLowerCase().includes(needle) ? [MOLE_PV] : [];
        return route.fulfill({ json: { archiver, pattern, pvs } });
      }
      if (resource === 'data' || resource === 'metadata') {
        if (pv !== MOLE_PV) {
          return moleError(route, 404, 'pv_not_found', `PV '${pv}' is not archived.`);
        }
        return route.fulfill({
          json:
            resource === 'data'
              ? moleData(pv, archiver, url.searchParams)
              : moleMetadata(pv, archiver),
        });
      }
      return moleError(route, 404, 'not_found', `No mocked Mole route for ${url.pathname}.`);
    }
  );
}
