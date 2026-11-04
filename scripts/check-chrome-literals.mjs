#!/usr/bin/env node
// Chrome literal guard: Trace's chrome takes its colours and fonts from the
// canopy contract variables, so a host stylesheet can restyle it. A colour or
// a font written as a literal escapes that contract. This script fails on any
// hex colour or non-contract font declaration in the chrome files -- and, in
// the workbench (FONT_SIZE_TREES), on any font size that is not a contract
// text size -- except on
// a line whose previous line carries `canopy-allow-literal: <reason>`, and it
// pins those exemptions to scripts/chrome-literals.allow so that none is
// added silently.
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

const HEX = /(?<!&)#[0-9a-fA-F]{3,8}\b/;
const FONT = /\b(?:font(?:-family)?|fontFamily)\s*:([^;]*)/g;
const FONT_SIZE = /(?<![\w-])(?:font-size|fontSize)\s*:([^;]*)/g;
const MARKER = /canopy-allow-literal:\s*(.*?)\s*(?:\*\/.*|-->.*)?$/;

/** The repo-relative key of a file, whatever form it was named in. */
export function keyOf(file) {
  return path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
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

/**
 * True when the stripped line holds a hex colour or a non-contract font; with
 * `fontSize`, also a font size other than `inherit` or a contract text size.
 */
export function isLiteral(line, { fontSize = false } = {}) {
  if (HEX.test(line)) return true;
  for (const [, raw] of line.matchAll(FONT)) {
    const value = raw.replace(/!important/, '').replace(/['"`,{}\s]/g, '');
    if (value !== 'inherit' && !raw.includes('var(--canopy-font-')) return true;
  }
  if (fontSize)
    for (const [, raw] of line.matchAll(FONT_SIZE)) {
      const value = raw.replace(/!important/, '').replace(/['"`,{}\s]/g, '');
      if (value !== 'inherit' && !raw.includes('var(--canopy-text-')) return true;
    }
  return false;
}

/**
 * The literal lines of one file: `hits` are unmarked, `exempt` carry a
 * marker on the previous line. The marker is read from the raw text, since
 * it lives in a comment. `options` go to isLiteral.
 */
export function scan(text, options = {}) {
  const raw = text.split('\n');
  const stripped = stripComments(text).split('\n');
  const hits = [];
  const exempt = [];
  stripped.forEach((line, i) => {
    if (!isLiteral(line, options)) return;
    const marker = i > 0 ? MARKER.exec(raw[i - 1]) : null;
    if (marker) exempt.push({ line: i + 1, reason: marker[1] });
    else hits.push({ line: i + 1, text: raw[i].trim() });
  });
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
    const { hits, exempt } = scan(read(file), { fontSize: gatesFontSize(key) });
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
