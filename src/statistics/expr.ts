// The metric expression language: a small, dependency-free arithmetic language
// over a statistics frame (evaluate.ts), compiled once per expression and
// evaluated per row per frame. Shared by every tool; the catalog
// (model.ts `MetricCatalog`) names the variables and which of them are
// vectors, so static shape inference works per tool.
//
// Values are scalars (number) or vectors (Float64Array) of equal length — the
// rows where every referenced column is finite, built by the caller. Binary
// operators broadcast a scalar over a vector; two vectors combine element-wise.
// Aggregates reduce a vector to a scalar. The result must be a finite scalar:
// anything else is `null`, shown as "–", never 0.
//
//   expr     = sum
//   sum      = product { ("+" | "-") product }
//   product  = unary { ("*" | "/") unary }
//   unary    = "-" unary | power
//   power    = atom [ "^" unary ]                     right-associative; -2^2 = -4
//   atom     = number | name | name "(" [ expr { "," expr } ] ")" | "(" expr ")"
//
// Variables are the catalog's (`y` for the row's own values everywhere, `x`,
// `t`, `i` per tool), `y1`..`yK` (another row by position, always a vector),
// `n` (row count) and the constants `pi` and `e`. The language only needs to
// know which names are vectors (`ExprLanguage.isVector`); the catalog checks
// that every referenced name exists (model.ts `validateExpression`).
//
// Functions (`FUNCTION_REFERENCE`): element-wise `abs sqrt exp ln log10 log2
// sin cos tan floor ceil round sign`, `pow(a, b)`; aggregates `count sum mean
// median std var rms ptp first last argmin argmax`, `min`/`max` (one argument:
// aggregate; two or more: element-wise), `percentile(v, p)`, and the pairs
// `corr(a, b) cov(a, b) slope(a, b) intercept(a, b) r2(a, b)`. Their
// semantics: sample std (ddof = 1, n ≥ 2), r needs n ≥ 3 and spread in both,
// slope needs spread in `a`; a column has spread when its min differs from its
// max and its sample variance does not underflow to zero. Everything is
// two-pass (means first, then centred sums). Undefined is NaN inside and
// `null` outside.

/** A scalar or a vector over the evaluated rows. */
export type ExprValue = number | Float64Array;

/** The variables an evaluation sees: name → value. Vectors share one length. */
export type ExprEnv = Readonly<Record<string, ExprValue>>;

export interface CompiledExpression {
  /** The variable names the expression references, in first-use order. */
  readonly vars: readonly string[];
  /** The finite scalar result, or null (undefined, non-finite, or a vector). */
  evaluate(env: ExprEnv): number | null;
}

export type CompileResult =
  | { ok: true; compiled: CompiledExpression }
  | { ok: false; error: string; position: number };

/** What the compiler needs of a catalog: which variable names are vectors. */
export interface ExprLanguage {
  /** True for a vector variable (`y`, `x`, `t`, …); row references `y<k>` always are. */
  isVector(name: string): boolean;
}

const ROW_REF = /^y([1-9]\d*)$/;

/** `y<k>`: the k-th row's own values; k when the name is one, else null. */
export function rowReference(name: string): number | null {
  const m = ROW_REF.exec(name);
  return m === null ? null : Number(m[1]);
}

// ── Values ────────────────────────────────────────────────────────────────
//
// Every operation allocates its own output, so an evaluation never writes into
// the env's arrays. Two vectors of different lengths cannot combine: the result
// is a NaN scalar, which every later step carries through to `null`.

type Node = (env: ExprEnv) => ExprValue;

/** A node with its static shape: `vector` when it can never be a scalar. */
interface Typed {
  node: Node;
  vector: boolean;
}

type BinaryOp = '+' | '-' | '*' | '/' | '^' | 'min' | 'max';

function scalarOp(op: BinaryOp, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '^':
      return a ** b;
    case 'min':
      return Math.min(a, b);
    case 'max':
      return Math.max(a, b);
  }
}

/** `a op b` with a scalar broadcast over a vector; one loop, one allocation. */
function binary(op: BinaryOp, a: ExprValue, b: ExprValue): ExprValue {
  if (typeof a === 'number' && typeof b === 'number') return scalarOp(op, a, b);
  const av = typeof a === 'number' ? null : a;
  const bv = typeof b === 'number' ? null : b;
  if (av !== null && bv !== null && av.length !== bv.length) return NaN;
  const len = (av ?? bv)?.length ?? 0;
  const as = typeof a === 'number' ? a : 0;
  const bs = typeof b === 'number' ? b : 0;
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++)
    out[i] = scalarOp(op, av === null ? as : av[i], bv === null ? bs : bv[i]);
  return out;
}

/** `f` applied element-wise. */
function map(v: ExprValue, f: (x: number) => number): ExprValue {
  if (typeof v === 'number') return f(v);
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = f(v[i]);
  return out;
}

/** A scalar argument of an aggregate is a one-element vector. */
function asVector(v: ExprValue): Float64Array {
  return typeof v === 'number' ? Float64Array.of(v) : v;
}

function vsum(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s;
}

function vmean(v: Float64Array): number {
  return v.length === 0 ? NaN : vsum(v) / v.length;
}

/** Sum of squares about the mean: the second pass. */
function centred(v: Float64Array, m: number): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] - m) * (v[i] - m);
  return s;
}

/** Sample variance, ddof = 1; NaN below two values. */
function vvar(v: Float64Array): number {
  return v.length < 2 ? NaN : centred(v, vmean(v)) / (v.length - 1);
}

/** Smallest (or largest) value; NaN when empty or any value is NaN. */
function extreme(v: Float64Array, largest: boolean): number {
  if (v.length === 0) return NaN;
  let best = v[0];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (Number.isNaN(x)) return NaN;
    if (largest ? x > best : x < best) best = x;
  }
  return best;
}

/** 0-based index of the first smallest (or largest) value; NaN when empty or any value is NaN. */
function argExtreme(v: Float64Array, largest: boolean): number {
  if (v.length === 0) return NaN;
  let at = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (Number.isNaN(x)) return NaN;
    if (largest ? x > v[at] : x < v[at]) at = i;
  }
  return at;
}

/** numpy's default ("linear") percentile, p in 0..100. */
function percentile(v: Float64Array, p: number): number {
  if (v.length === 0 || !(p >= 0 && p <= 100)) return NaN;
  for (let i = 0; i < v.length; i++) if (Number.isNaN(v[i])) return NaN;
  const sorted = Float64Array.from(v).sort();
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

interface Pair {
  n: number;
  ma: number;
  mb: number;
  saa: number;
  sbb: number;
  sab: number;
}

/** The two-pass sums of a pair (means, then centred sums); null when the lengths differ. */
function pairSums(a: Float64Array, b: Float64Array): Pair | null {
  if (a.length !== b.length) return null;
  const n = a.length;
  const ma = vmean(a);
  const mb = vmean(b);
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    saa += da * da;
    sbb += db * db;
    sab += da * db;
  }
  return { n, ma, mb, saa, sbb, sab };
}

/** Spread: min ≠ max and the sample variance did not underflow. */
function spread(v: Float64Array, ss: number): boolean {
  return v.length >= 2 && extreme(v, false) !== extreme(v, true) && ss / (v.length - 1) > 0;
}

function slopeOf(a: Float64Array, p: Pair): number {
  return p.n >= 2 && spread(a, p.saa) ? p.sab / p.saa : NaN;
}

function corrOf(a: Float64Array, b: Float64Array, p: Pair): number {
  if (p.n < 3 || !spread(a, p.saa) || !spread(b, p.sbb)) return NaN;
  return Math.min(1, Math.max(-1, p.sab / Math.sqrt(p.saa * p.sbb)));
}

// ── Functions ─────────────────────────────────────────────────────────────

/**
 * A lookup table with no prototype, so a name like `constructor` or
 * `__proto__` in an expression is never an Object.prototype member.
 */
function table<T>(entries: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}

/** round half away from zero (Math.round rounds -2.5 to -2). */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

const ELEMENTWISE: Readonly<Record<string, (x: number) => number>> = table({
  abs: Math.abs,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  floor: Math.floor,
  ceil: Math.ceil,
  round: roundHalfAway,
  sign: Math.sign,
});

const AGGREGATES: Readonly<Record<string, (v: Float64Array) => number>> = table({
  count: (v) => v.length,
  sum: vsum,
  mean: vmean,
  median: (v) => percentile(v, 50),
  std: (v) => Math.sqrt(vvar(v)),
  var: vvar,
  rms: (v) => {
    if (v.length === 0) return NaN;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s / v.length);
  },
  ptp: (v) => extreme(v, true) - extreme(v, false),
  first: (v) => (v.length === 0 ? NaN : v[0]),
  last: (v) => (v.length === 0 ? NaN : v[v.length - 1]),
  argmin: (v) => argExtreme(v, false),
  argmax: (v) => argExtreme(v, true),
});

const PAIRS: Readonly<Record<string, (a: Float64Array, b: Float64Array, p: Pair) => number>> =
  table({
    corr: corrOf,
    cov: (_a, _b, p) => (p.n >= 2 ? p.sab / (p.n - 1) : NaN),
    slope: (a, _b, p) => slopeOf(a, p),
    intercept: (a, _b, p) => p.mb - slopeOf(a, p) * p.ma,
    r2: (a, b, p) => corrOf(a, b, p) ** 2,
  });

const CONSTANTS: Readonly<Record<string, number>> = table({ pi: Math.PI, e: Math.E });

/** Arity per function: [min, max]; max Infinity for variadic min/max. */
function arity(name: string): readonly [number, number] | null {
  if (Object.hasOwn(ELEMENTWISE, name) || Object.hasOwn(AGGREGATES, name)) return [1, 1];
  if (Object.hasOwn(PAIRS, name) || name === 'pow' || name === 'percentile' || name === 'at')
    return [2, 2];
  if (name === 'min' || name === 'max') return [1, Infinity];
  return null;
}

/** The node for a call whose name and arity are already checked. */
/** The static shape of a call: element-wise follows its argument, aggregates reduce. */
function callShape(name: string, args: Typed[]): boolean {
  if (Object.hasOwn(ELEMENTWISE, name)) return (args[0] as Typed).vector;
  if (name === 'pow' || ((name === 'min' || name === 'max') && args.length > 1)) {
    return args.some((arg) => arg.vector);
  }
  return false;
}

function callNode(name: string, args: Node[]): Node {
  const [a, b] = args as [Node, Node];
  const unary = ELEMENTWISE[name];
  if (unary !== undefined) return (env) => map(a(env), unary);
  const agg = AGGREGATES[name];
  if (agg !== undefined) return (env) => agg(asVector(a(env)));
  const pair = PAIRS[name];
  if (pair !== undefined) {
    return (env) => {
      const va = asVector(a(env));
      const vb = asVector(b(env));
      const p = pairSums(va, vb);
      return p === null ? NaN : pair(va, vb, p);
    };
  }
  if (name === 'pow') return (env) => binary('^', a(env), b(env));
  if (name === 'percentile') {
    return (env) => {
      const p = b(env);
      return typeof p === 'number' ? percentile(asVector(a(env)), p) : NaN;
    };
  }
  if (name === 'at') {
    return (env) => {
      const v = asVector(a(env));
      const k = b(env);
      return typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < v.length ? v[k] : NaN;
    };
  }
  // min / max
  const largest = name === 'max';
  if (args.length === 1) return (env) => extreme(asVector(a(env)), largest);
  const op: BinaryOp = largest ? 'max' : 'min';
  return (env) => {
    let acc = a(env);
    for (let i = 1; i < args.length; i++) acc = binary(op, acc, (args[i] as Node)(env));
    return acc;
  };
}

// ── Tokens ────────────────────────────────────────────────────────────────

type Token =
  | { kind: 'number'; value: number; text: string; pos: number }
  | { kind: 'name'; text: string; pos: number }
  | { kind: 'op'; text: string; pos: number }
  | { kind: 'end'; text: ''; pos: number };

class ExprError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num !== null) {
      tokens.push({ kind: 'number', value: Number(num[0]), text: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(src);
    if (name !== null) {
      tokens.push({ kind: 'name', text: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      tokens.push({ kind: 'op', text: c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}'`, i);
  }
  tokens.push({ kind: 'end', text: '', pos: src.length });
  return tokens;
}

// ── Parser ────────────────────────────────────────────────────────────────
//
// Recursive descent over the grammar in the header, building the closure tree
// directly. `vars` collects variable names in first-use order.

class Parser {
  private i = 0;
  readonly vars: string[] = [];

  private readonly tokens: Token[];
  private readonly lang: ExprLanguage;

  constructor(tokens: Token[], lang: ExprLanguage) {
    this.tokens = tokens;
    this.lang = lang;
  }

  private peek(): Token {
    return this.tokens[this.i] as Token;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'end') this.i++;
    return t;
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.text === text;
  }

  private unexpected(t: Token): ExprError {
    return t.kind === 'end'
      ? new ExprError('Unexpected end of expression', t.pos)
      : new ExprError(`Unexpected '${t.text}'`, t.pos);
  }

  private expectClose(): void {
    if (!this.isOp(')')) throw new ExprError("Expected ')'", this.peek().pos);
    this.i++;
  }

  parseAll(): Typed {
    if (this.peek().kind === 'end') throw new ExprError('Empty expression', 0);
    const typed = this.sum();
    const t = this.peek();
    if (t.kind !== 'end') throw this.unexpected(t);
    return typed;
  }

  private sum(): Typed {
    let left = this.product();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().text as BinaryOp;
      const l = left.node;
      const r = this.product();
      left = { node: (env) => binary(op, l(env), r.node(env)), vector: left.vector || r.vector };
    }
    return left;
  }

  private product(): Typed {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.next().text as BinaryOp;
      const l = left.node;
      const r = this.unary();
      left = { node: (env) => binary(op, l(env), r.node(env)), vector: left.vector || r.vector };
    }
    return left;
  }

  private unary(): Typed {
    if (this.isOp('-')) {
      this.next();
      const operand = this.unary();
      return { node: (env) => map(operand.node(env), (x) => -x), vector: operand.vector };
    }
    return this.power();
  }

  private power(): Typed {
    const base = this.atom();
    if (!this.isOp('^')) return base;
    this.next();
    const exponent = this.unary();
    return {
      node: (env) => binary('^', base.node(env), exponent.node(env)),
      vector: base.vector || exponent.vector,
    };
  }

  private atom(): Typed {
    const t = this.next();
    if (t.kind === 'number') {
      const value = t.value;
      return { node: () => value, vector: false };
    }
    if (t.kind === 'op' && t.text === '(') {
      const inner = this.sum();
      this.expectClose();
      return inner;
    }
    if (t.kind !== 'name') throw this.unexpected(t);
    if (this.isOp('(')) return this.call(t);
    const name = t.text;
    const constant = CONSTANTS[name];
    if (constant !== undefined) return { node: () => constant, vector: false };
    if (arity(name) !== null) throw new ExprError(`${name} is a function: write ${name}(…)`, t.pos);
    if (!this.vars.includes(name)) this.vars.push(name);
    const vector = rowReference(name) !== null || this.lang.isVector(name);
    return { node: (env) => env[name] ?? NaN, vector };
  }

  private call(t: Token): Typed {
    const name = t.text;
    const bounds = arity(name);
    if (bounds === null) throw new ExprError(`Unknown function ${name}`, t.pos);
    this.next(); // "("
    const args: Typed[] = [];
    if (!this.isOp(')')) {
      args.push(this.sum());
      while (this.isOp(',')) {
        this.next();
        args.push(this.sum());
      }
    }
    this.expectClose();
    const [lo, hi] = bounds;
    if (args.length < lo || args.length > hi) {
      const count = `${lo} argument${lo === 1 ? '' : 's'}`;
      throw new ExprError(
        `${name} expects ${hi === Infinity ? `at least ${count}` : count}`,
        t.pos
      );
    }
    return {
      node: callNode(
        name,
        args.map((arg) => arg.node)
      ),
      vector: callShape(name, args),
    };
  }
}

/** The error of an expression whose result is a vector, never one number. */
export const NOT_SCALAR = 'Expression must reduce to one number: use an aggregate like mean(…)';

/** Parse and compile `expr` in `lang`; an error names the problem and its 0-based offset. */
export function compileExpression(expr: string, lang: ExprLanguage): CompileResult {
  let root: Node;
  let vars: readonly string[];
  try {
    const parser = new Parser(tokenize(expr), lang);
    const typed = parser.parseAll();
    if (typed.vector) throw new ExprError(NOT_SCALAR, 0);
    root = typed.node;
    vars = Object.freeze([...parser.vars]);
  } catch (err) {
    if (err instanceof ExprError) return { ok: false, error: err.message, position: err.position };
    throw err;
  }
  return {
    ok: true,
    compiled: {
      vars,
      evaluate(env: ExprEnv): number | null {
        for (const name of vars) if (!Object.hasOwn(env, name)) return null;
        const value = root(env);
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      },
    },
  };
}

export interface ReferenceEntry {
  name: string;
  /** `corr(a, b)` — the call shape, for the help list. */
  signature: string;
  description: string;
}

const entry = (name: string, signature: string, description: string): ReferenceEntry => ({
  name,
  signature,
  description,
});

/** The function reference the editor's help lists; the variables are the catalog's. */
export const FUNCTION_REFERENCE: readonly ReferenceEntry[] = [
  entry('abs', 'abs(v)', 'Absolute value, element-wise.'),
  entry('sqrt', 'sqrt(v)', 'Square root, element-wise.'),
  entry('exp', 'exp(v)', 'e raised to v, element-wise.'),
  entry('ln', 'ln(v)', 'Natural logarithm, element-wise.'),
  entry('log10', 'log10(v)', 'Base-10 logarithm, element-wise.'),
  entry('log2', 'log2(v)', 'Base-2 logarithm, element-wise.'),
  entry('sin', 'sin(v)', 'Sine of radians, element-wise.'),
  entry('cos', 'cos(v)', 'Cosine of radians, element-wise.'),
  entry('tan', 'tan(v)', 'Tangent of radians, element-wise.'),
  entry('floor', 'floor(v)', 'Round down, element-wise.'),
  entry('ceil', 'ceil(v)', 'Round up, element-wise.'),
  entry('round', 'round(v)', 'Round to nearest, halves away from zero, element-wise.'),
  entry('sign', 'sign(v)', '-1, 0 or 1 by sign, element-wise.'),
  entry('pow', 'pow(a, b)', 'a raised to b, element-wise; same as a ^ b.'),
  entry('count', 'count(v)', 'Number of values.'),
  entry('sum', 'sum(v)', 'Sum of the values.'),
  entry('mean', 'mean(v)', 'Arithmetic mean (needs 1 value).'),
  entry('median', 'median(v)', 'Middle value; mean of the two middle ones for even counts.'),
  entry('std', 'std(v)', 'Sample standard deviation, ddof = 1 (needs 2 values).'),
  entry('var', 'var(v)', 'Sample variance, ddof = 1 (needs 2 values).'),
  entry('rms', 'rms(v)', 'Root mean square, sqrt(mean(v²)); not centred.'),
  entry('ptp', 'ptp(v)', 'Peak to peak: max(v) − min(v).'),
  entry('first', 'first(v)', 'The oldest value.'),
  entry('last', 'last(v)', 'The newest value.'),
  entry('argmin', 'argmin(v)', '0-based position of the smallest value.'),
  entry('argmax', 'argmax(v)', '0-based position of the largest value.'),
  entry('min', 'min(v) · min(a, b, …)', 'Smallest value; with several arguments, element-wise.'),
  entry('max', 'max(v) · max(a, b, …)', 'Largest value; with several arguments, element-wise.'),
  entry('percentile', 'percentile(v, p)', 'p-th percentile, p in 0..100, linear interpolation.'),
  entry('at', 'at(v, k)', 'The k-th value of v (0-based), e.g. at(i, argmax(y)).'),
  entry('corr', 'corr(a, b)', 'Pearson r (needs 3 rows and spread in both).'),
  entry('cov', 'cov(a, b)', 'Sample covariance, ddof = 1 (needs 2 rows).'),
  entry('slope', 'slope(a, b)', 'Least-squares slope of b against a (needs spread in a).'),
  entry('intercept', 'intercept(a, b)', 'Least-squares intercept of b against a.'),
  entry('r2', 'r2(a, b)', 'Coefficient of determination, corr(a, b)².'),
];
