#!/usr/bin/env node
// Chrome literal guard: Trace's chrome takes its colours and fonts from the
// canopy contract variables, so a host stylesheet can restyle it. A colour or
// a font written as a literal escapes that contract. This script fails on any
// hex colour or non-contract font declaration in the chrome files -- and, in
// the workbench (FONT_SIZE_TREES), on any font size that is not a contract
// text size -- except on a line whose previous line carries
// `canopy-allow-literal: <reason>`, and it pins those exemptions to
// scripts/chrome-literals.allow so that none is added silently.
//
// What is scanned depends on the file (kindOf): a stylesheet is read for its
// declarations, so a selector such as `#feed {` or a `url(#id)` is not a
// colour; a TypeScript or JSX file is parsed, and only its string literals,
// template literals and style objects are read, so a type such as
// `font: string`, a link such as `href="#a11"`, a selector passed to
// `querySelector` or a comment is not. CONTRIBUTING.md documents the rule.
//
//   node scripts/check-chrome-literals.mjs [file-or-glob ...]
//
// Without arguments it checks defaultFiles() -- DEFAULT_FILES plus every file
// under GUARDED_TREES -- and the exemptions found must
// equal the allow file in both directions. With arguments it checks only the
// named files, and every exemption found there must be covered by the allow
// file. Exit 1 on a literal, an unknown reason, an allow-file mismatch, a
// missing file or an empty file set.
import { globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** The repository root; every file is keyed by its path relative to it. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The chrome files checked when no argument is given. */
export const DEFAULT_FILES = [
  'src/App.css',
  'src/index.css',
  'src/tools/correlation/correlation.css',
  'src/components/PvCombo.tsx',
].map((rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url)));

/**
 * Directories whose chrome files are all checked, found by a walk so a file
 * added later is guarded without editing this list. A directory that does not
 * exist yet contributes nothing. In the workbench every stylesheet and
 * production module is chrome; its tests and `__fixtures__` hold sample data
 * (colour values included) and are not. Waveform's chrome is its stylesheets.
 * The plot interaction layer (src/plot) and the drawing core (src/annotations)
 * are chrome in every stylesheet and production module (their tests excepted);
 * plot colours come from canopy-charts and drawing colours from
 * src/annotationTheme.ts, which lies outside
 * both trees.
 */
export const GUARDED_TREES = [
  {
    dir: 'src/workbench',
    include: /\.(?:css|tsx?)$/,
    exclude: /(?:\.test\.tsx?$|(?:^|\/)__fixtures__\/)/,
  },
  { dir: 'src/tools/waveform', include: /\.css$/, exclude: null },
  { dir: 'src/statistics', include: /\.css$/, exclude: null },
  { dir: 'src/plot', include: /\.(?:css|tsx?)$/, exclude: /\.test\.tsx?$/ },
  { dir: 'src/annotations', include: /\.(?:css|tsx?)$/, exclude: /\.test\.tsx?$/ },
];

/** The files of one guarded tree as repo-relative keys, sorted; [] when it is absent. */
export function treeFiles({ dir, include, exclude }, root = ROOT) {
  const base = path.join(root, dir);
  if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    )
    .filter((rel) => include.test(rel) && !(exclude && exclude.test(rel)))
    .sort();
}

/** Everything a no-argument run checks, as absolute paths. Reads the tree. */
export function defaultFiles(root = ROOT) {
  const walked = GUARDED_TREES.flatMap((tree) => treeFiles(tree, root)).map((rel) =>
    path.join(root, rel)
  );
  return [...DEFAULT_FILES, ...walked.filter((file) => !DEFAULT_FILES.includes(file))];
}

export const ALLOW_FILE = fileURLToPath(new URL('./chrome-literals.allow', import.meta.url));

/** The closed vocabulary of exemption reasons. */
export const REASONS = [
  'document background',
  '@media print',
  'widget prop default',
  'Carbon danger pair',
];

/**
 * Repo-relative prefixes whose files also gate font sizes: every sidebar row
 * and heading there reads `--canopy-text-sm`/`--canopy-text-md`, so a host
 * scale reaches them in one place. Elsewhere a font size is not checked.
 */
export const FONT_SIZE_TREES = ['src/workbench/'];

/** True when `key` (repo-relative) lies in a tree whose font sizes are gated. */
export function gatesFontSize(key) {
  return FONT_SIZE_TREES.some((prefix) => key.startsWith(prefix));
}

/** A hex colour token: valid lengths only, not an `&#160;` entity or a longer word. */
const HEX_TOKEN = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?!\w)/gi;
const FONT = /\b(?:font(?:-family)?|fontFamily)\s*:([^;]*)/g;
const FONT_SIZE = /(?<![\w-])(?:font-size|fontSize)\s*:([^;]*)/g;
const MARKER = /canopy-allow-literal:\s*(.*?)\s*(?:\*\/.*|-->.*)?$/;

/** The repo-relative key of a file, whatever form it was named in. */
export function keyOf(file) {
  return path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
}

/**
 * The syntax a file is scanned as, from its extension: 'css', 'tsx' (also
 * jsx) or 'ts' (also js, mjs, cjs). Anything else is `undefined`, which scans
 * the raw text line by line without the context rules below.
 */
export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.css') return 'css';
  if (ext === '.tsx' || ext === '.jsx') return 'tsx';
  if (['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].includes(ext)) return 'ts';
  return undefined;
}

/**
 * `text` with every block and line comment blanked, line count unchanged.
 * Quoted strings are copied through, so a `//` or a `#hex` inside one
 * survives; a `//` straight after a colon is a URL, not a comment.
 */
export function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) out += text[++i];
      else if (c === quote || (c === '\n' && quote !== '`')) quote = null;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (c === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
      const end = text.indexOf('\n', i);
      i = (end === -1 ? text.length : end) - 1;
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
    }
  }
  return out;
}

/** Spaces for every character but a newline, so offsets and line numbers survive. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** The bare value of a font declaration: no `!important`, quotes, commas, braces or spaces. */
const bare = (raw) => raw.replace(/!important/, '').replace(/['"`,{}\s]/g, '');

/** True when a `font`/`font-family` value is `inherit` or names a contract font variable. */
const fontValueOk = (raw) => bare(raw) === 'inherit' || raw.includes('var(--canopy-font-');

/** True when a `font-size` value is `inherit` or names a contract text size. */
const sizeValueOk = (raw) => bare(raw) === 'inherit' || raw.includes('var(--canopy-text-');

/**
 * `value` with what is not a colour written out blanked: `url(...)` (an
 * `#id` fragment), the name inside `var(--name` and, unless `keepQuoted`,
 * quoted text. A string literal's own content keeps its quotes: they may be
 * those of JSON the string holds.
 */
function colourText(value, keepQuoted) {
  return (keepQuoted ? value : value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, blank))
    .replace(/url\([^)]*\)/gi, blank)
    .replace(/var\(\s*--[\w-]+/gi, (m) => `var(${blank(m.slice(4))}`);
}

/**
 * Offsets in `value` of colour literals. `leadingHex` limits hex colours to
 * those a CSS value can start with, so prose such as `see issue #123` passes.
 */
function colourOffsets(value, { leadingHex = false, keepQuoted = false } = {}) {
  const text = colourText(value, keepQuoted);
  const out = [];
  for (const m of text.matchAll(HEX_TOKEN)) {
    const before = text.slice(0, m.index);
    if (
      !leadingHex ||
      /(?:^|[(,:"']|\b(?:solid|dashed|dotted|double|inset|outset|none)|\d(?:px|r?em|%|pt)?)\s*$/i.test(
        before
      )
    )
      out.push(m.index);
  }
  return out;
}

/** The property names whose values are checked for a colour literal in a string. */
const STYLE_PROP =
  /^(?:font|font-family|font-size|--[\w-]+|background|border|outline|fill|stroke|(?:[\w-]+-)?color)$/i;

/** A declaration: `prop: value` ended by `;`, `}` or the end; a selector ends in `{` and is not one. */
const DECL = /(?<![\w-])(--[\w-]+|[a-z][a-z0-9-]*)\s*:(?!:)\s*([^;{}]*)(?=[;}]|$)/gi;

/**
 * Offsets in `text` of literal declarations: a colour in a value, or a
 * non-contract font (and, with `fontSize`, font size). With `onlyStyleProps`
 * only the properties of STYLE_PROP count, for CSS-looking text in a string.
 */
function declOffsets(text, { fontSize, onlyStyleProps = false }) {
  const out = [];
  for (const m of text.matchAll(DECL)) {
    const prop = m[1].toLowerCase();
    if (onlyStyleProps && !STYLE_PROP.test(prop)) continue;
    const base = m.index + m[0].length - m[2].length;
    for (const at of colourOffsets(m[2])) out.push(base + at);
    if ((prop === 'font' || prop === 'font-family') && !fontValueOk(m[2])) out.push(base);
    if (fontSize && prop === 'font-size' && !sizeValueOk(m[2])) out.push(base);
  }
  return out;
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** Property keys that carry a font, in a JS object. */
const FONT_KEYS = new Set(['font', 'fontFamily']);

/** JSX attributes and object keys whose string value is a colour. */
const COLOUR_ATTR = /^(?:fill|stroke|color|bgcolor|(?:stop|flood|lighting)-?color)$/i;
const COLOUR_KEY = /colou?r|background|fill|stroke|border|outline|shadow|^bg/i;

/** Calls whose string argument is a selector, a lookup key or a message, never a style. */
const NON_STYLE_CALLEE =
  /(?:^|\.)(?:querySelector(?:All)?|getElementById|getElementsBy\w+|closest|matches|getAttribute|hasAttribute|require|import|\w*Error|console\.\w+)$/;

const TRANSPARENT_PARENTS = (n, p) =>
  ts.isParenthesizedExpression(p) ||
  ts.isAsExpression(p) ||
  ts.isSatisfiesExpression(p) ||
  ts.isNonNullExpression(p) ||
  ts.isTemplateSpan(p) ||
  ts.isTemplateExpression(p) ||
  ts.isJsxExpression(p) ||
  (ts.isConditionalExpression(p) && p.condition !== n) ||
  (ts.isBinaryExpression(p) && p.operatorToken.kind !== ts.SyntaxKind.EqualsToken);

/** What a string is used for: its JSX attribute, object key or assignment target, or the call it is an argument of. */
function contextOf(owner) {
  let n = owner;
  let p = n.parent;
  while (p && TRANSPARENT_PARENTS(n, p)) {
    n = p;
    p = p.parent;
  }
  if (!p) return {};
  if (ts.isJsxAttribute(p)) return { attr: p.name.getText() };
  if (ts.isPropertyAssignment(p) && p.initializer === n)
    return { key: p.name.getText().replace(/^['"]|['"]$/g, '') };
  if (ts.isBinaryExpression(p) && p.right === n && ts.isPropertyAccessExpression(p.left))
    return { key: p.left.name.text, assign: true };
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== n)
    return { callee: p.expression.getText() };
  return {};
}

/** True for an object literal that is a React style object: `style={{...}}`, `style: {...}` or a CSSProperties value. */
function isStyleObject(node) {
  const p = node.parent;
  if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent))
    return p.parent.name.getText() === 'style';
  if (ts.isPropertyAssignment(p)) return p.name.getText() === 'style';
  if (ts.isVariableDeclaration(p) && p.type) return /CSSProperties/.test(p.type.getText());
  if (ts.isAsExpression(p) || ts.isSatisfiesExpression(p))
    return /CSSProperties/.test(p.type.getText());
  return false;
}

const hasString = (node) => {
  let found = false;
  const walk = (n) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) found = true;
    else ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
};

/**
 * The 1-based lines of a JS/TS/JSX file that hold a style literal. Only
 * string literals, template literals and style objects are looked at; JSX
 * text, comments, types, identifiers, selectors and `href="#id"` are not.
 */
function tsLines(text, { tsx, fontSize }) {
  const sf = ts.createSourceFile(
    tsx ? 'file.tsx' : 'file.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const lines = new Set();
  const flag = (pos) => lines.add(sf.getLineAndCharacterOfPosition(pos).line + 1);

  const literal = (node, owner) => {
    const parent = owner.parent;
    if (
      ts.isLiteralTypeNode(parent) ||
      ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent) ||
      (ts.isPropertyAssignment(parent) && parent.name === owner) ||
      (ts.isElementAccessExpression(parent) && parent.argumentExpression === owner)
    )
      return;
    const ctx = contextOf(owner);
    if (ctx.callee && NON_STYLE_CALLEE.test(ctx.callee)) return;
    if (ctx.attr !== undefined && !COLOUR_ATTR.test(ctx.attr)) return;
    const start = node.getStart(sf);
    // The quotes and `${` delimiters are not content.
    const raw = node
      .getText(sf)
      .replace(/^[`'"}]/, blank)
      .replace(/(?:\$\{|[`'"])$/, blank);
    const colourValue =
      (ctx.attr !== undefined && COLOUR_ATTR.test(ctx.attr)) ||
      (ctx.key !== undefined && COLOUR_KEY.test(ctx.key));
    for (const at of colourOffsets(raw, { leadingHex: !colourValue, keepQuoted: true }))
      flag(start + at);
    for (const at of declOffsets(raw, { fontSize, onlyStyleProps: true })) flag(start + at);
    // Key-driven font checks run once per value: on the whole template, not its pieces.
    if (node === owner || ts.isTemplateHead(node)) {
      const value = owner.getText(sf);
      if (ctx.key !== undefined && !ctx.assign) {
        if (FONT_KEYS.has(ctx.key) && !fontValueOk(value)) flag(start);
        if (fontSize && ctx.key === 'fontSize' && !sizeValueOk(value)) flag(start);
      }
    }
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal(node, node);
    else if (ts.isTemplateExpression(node)) {
      literal(node.head, node);
      for (const span of node.templateSpans) literal(span.literal, node);
    } else if (ts.isObjectLiteralExpression(node) && isStyleObject(node)) {
      // Non-string values (a number, an identifier) under a font key escape the string checks.
      const walk = (n) => {
        if (
          (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
          !(ts.isPropertyAssignment(n) && hasString(n.initializer))
        ) {
          const key = n.name.getText();
          if (FONT_KEYS.has(key) || (fontSize && key === 'fontSize')) flag(n.getStart(sf));
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(node, walk);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/** The 1-based lines of `text` that hold a style literal, for the syntax `kind` (see kindOf). */
function literalLines(text, { fontSize = false, kind } = {}) {
  if (kind === 'ts' || kind === 'tsx') return tsLines(text, { tsx: kind === 'tsx', fontSize });
  const stripped = stripComments(text);
  if (kind === 'css')
    return new Set(declOffsets(stripped, { fontSize }).map((at) => lineAt(stripped, at)));
  // Unknown syntax: every line, as raw text.
  const lines = new Set();
  stripped.split('\n').forEach((line, i) => {
    if (rawLineIsLiteral(line, fontSize)) lines.add(i + 1);
  });
  return lines;
}

/** The line-by-line test for text of unknown syntax. */
function rawLineIsLiteral(line, fontSize) {
  if (new RegExp(HEX_TOKEN).test(line)) return true;
  for (const [, raw] of line.matchAll(FONT)) if (!fontValueOk(raw)) return true;
  if (fontSize) for (const [, raw] of line.matchAll(FONT_SIZE)) if (!sizeValueOk(raw)) return true;
  return false;
}

/**
 * True when `line` holds a style literal: a hex colour or a non-contract
 * font; with `fontSize`, also a font size other than `inherit` or a contract
 * text size. `kind` (see kindOf) selects the syntax rules; without it the
 * line is read as raw text.
 */
export function isLiteral(line, options = {}) {
  return literalLines(line, options).size > 0;
}

/**
 * The literal lines of one file: `hits` are unmarked, `exempt` carry a
 * marker on the previous line. The marker is read from the raw text, since
 * it lives in a comment. `options` ({ fontSize, kind }) go to isLiteral.
 */
export function scan(text, options = {}) {
  const raw = text.split('\n');
  const hits = [];
  const exempt = [];
  for (const n of [...literalLines(text, options)].sort((a, b) => a - b)) {
    const i = n - 1;
    const marker = i > 0 ? MARKER.exec(raw[i - 1]) : null;
    if (marker) exempt.push({ line: n, reason: marker[1] });
    else hits.push({ line: n, text: raw[i].trim() });
  }
  return { hits, exempt };
}

/**
 * The allow file as a map from `<file>: <reason>` to its count. Each line is
 * `<repo-relative file>: <reason>: <count>`; blank lines and `#` lines are
 * skipped. Throws on a malformed line, an unknown reason or a repeated entry.
 */
export function parseAllow(text) {
  const allow = new Map();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = /^(.+?): (.+): (\d+)$/.exec(line.trim());
    if (!m) throw new Error(`chrome-literals.allow: malformed line: ${line}`);
    if (!REASONS.includes(m[2])) throw new Error(`chrome-literals.allow: unknown reason: ${m[2]}`);
    const key = `${m[1]}: ${m[2]}`;
    if (allow.has(key)) throw new Error(`chrome-literals.allow: repeated entry: ${key}`);
    allow.set(key, Number(m[3]));
  }
  return allow;
}

/**
 * Check `files`. `full` demands that the exemptions found equal the allow
 * file in both directions; otherwise they only have to be covered by it.
 * Returns the lines to print: `errors` (non-empty means failure) and `report`.
 */
export function check(files, { full, allowText, read = (f) => readFileSync(f, 'utf8') }) {
  const errors = [];
  const report = [];
  const found = new Map();
  if (files.length === 0) errors.push('no files to check');
  for (const file of files) {
    const key = keyOf(file);
    const { hits, exempt } = scan(read(file), { fontSize: gatesFontSize(key), kind: kindOf(file) });
    for (const hit of hits) errors.push(`${key}:${hit.line}: ${hit.text}`);
    for (const { line, reason } of exempt) {
      if (!REASONS.includes(reason)) {
        errors.push(`${key}:${line}: unknown canopy-allow-literal reason: ${reason}`);
        continue;
      }
      report.push(`${key}:${line}: ${reason}`);
      found.set(`${key}: ${reason}`, (found.get(`${key}: ${reason}`) ?? 0) + 1);
    }
  }
  let allow = new Map();
  try {
    allow = parseAllow(allowText);
  } catch (err) {
    errors.push(err.message);
  }
  for (const [entry, count] of found) {
    const allowed = allow.get(entry);
    if (allowed === undefined) errors.push(`not in chrome-literals.allow: ${entry}: ${count}`);
    else if (full ? count !== allowed : count > allowed)
      errors.push(`chrome-literals.allow says ${entry}: ${allowed}, found ${count}`);
  }
  if (full)
    for (const [entry, allowed] of allow)
      if (!found.has(entry))
        errors.push(`chrome-literals.allow entry with no marked line: ${entry}: ${allowed}`);
  return { errors, report: [`${report.length} exempt`, ...report] };
}

/** The files named by argv: a glob expands (possibly to nothing), a path must exist. */
export function expand(args) {
  const files = [];
  for (const arg of args) {
    if (/[*?[\]{}]/.test(arg)) files.push(...globSync(arg));
    else if (statSync(arg, { throwIfNoEntry: false })?.isFile()) files.push(arg);
    else throw new Error(`no such file: ${arg}`);
  }
  return files;
}

function main() {
  const args = process.argv.slice(2);
  let result;
  try {
    const files = args.length > 0 ? expand(args) : expand(defaultFiles());
    result = check(files, { full: args.length === 0, allowText: readFileSync(ALLOW_FILE, 'utf8') });
  } catch (err) {
    result = { errors: [err.message], report: [] };
  }
  if (result.errors.length > 0) {
    console.error('check-chrome-literals: FAIL');
    for (const line of result.errors) console.error(`  ${line}`);
    process.exit(1);
  }
  for (const line of result.report) console.log(line);
}

// Importing this module (the unit test does) must not read files or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
