// The one printer behind every tool's Code tab.
//
// A tool hands this a chart-option fragment taken from the same builder that
// feeds its chart — the top-level option without series data, one axis, or
// one series — and gets back stable, readable source to show and copy. Data
// never reaches the page: every typed array, every `data` array and every
// dataset `source` (rows, or each column of a record of columns) is printed
// as `/* n points */`, where n is the outer length. Pure and ECharts-free.
//
// Determinism: keys are ordered id, type, name first and the rest
// alphabetically, so the text does not depend on how the builder happened to
// assemble the object. Functions, symbols and undefined are dropped from
// objects and printed as `null` inside arrays (as JSON does), so positions in
// a pair like [min, max] survive. A reference back to an ancestor prints as
// `/* circular */`. Short arrays of primitives stay on one line.

const INDENT = '  ';
const INLINE_LIMIT = 72;
const LEADING_KEYS = ['id', 'type', 'name'];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

type Mode = 'plain' | 'data' | 'columns';

function points(n: number): string {
  return `/* ${n} points */`;
}

function isDropped(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function quote(s: string): string {
  let out = "'";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === "'") out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}'`;
}

function printKey(key: string): string {
  return IDENTIFIER.test(key) ? key : quote(key);
}

function orderKeys(keys: string[]): string[] {
  const lead = LEADING_KEYS.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !LEADING_KEYS.includes(k)).sort();
  return [...lead, ...rest];
}

function primitive(value: unknown): string | null {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return quote(value);
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value);
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value}n`;
    default:
      return null;
  }
}

/** Mode a key's value is printed in, given the mode of the object holding it. */
function childMode(key: string, parent: Mode): Mode {
  if (parent === 'columns') return 'data';
  if (key === 'data') return 'data';
  if (key === 'source') return 'columns';
  return 'plain';
}

function print(value: unknown, mode: Mode, depth: number, ancestors: object[]): string {
  if (isDropped(value)) return 'null';
  const prim = primitive(value);
  if (prim !== null) return prim;

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return points((value as unknown as ArrayLike<unknown>).length);
  }
  if (Array.isArray(value) && mode !== 'plain') return points(value.length);
  if (ancestors.includes(value as object)) return '/* circular */';

  const inner = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);
  const chain = [...ancestors, value as object];

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => print(item, 'plain', depth + 1, chain));
    const allPrimitive = value.every((item) => isDropped(item) || primitive(item) !== null);
    const inline = `[${items.join(', ')}]`;
    if (allPrimitive && inline.length <= INLINE_LIMIT) return inline;
    return `[\n${items.map((item) => inner + item).join(',\n')}\n${close}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = orderKeys(Object.keys(record).filter((k) => !isDropped(record[k])));
  if (keys.length === 0) return '{}';
  // A record of columns is data only under `source`; anywhere else it is plain.
  const objMode: Mode = mode === 'columns' ? 'columns' : 'plain';
  const lines = keys.map(
    (k) => `${inner}${printKey(k)}: ${print(record[k], childMode(k, objMode), depth + 1, chain)}`
  );
  return `{\n${lines.join(',\n')}\n${close}}`;
}

/** Print a chart-option fragment as Code-tab source, with all data elided. */
export function codeFragment(fragment: unknown): string {
  return print(fragment, 'plain', 0, []);
}
