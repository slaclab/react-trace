import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_FILES,
  GUARDED_TREES,
  REASONS,
  ROOT,
  check,
  defaultFiles,
  isLiteral,
  keyOf,
  kindOf,
  parseAllow,
  scan,
  stripComments,
  treeFiles,
} from './check-chrome-literals.mjs';

const SCRIPT = fileURLToPath(new URL('./check-chrome-literals.mjs', import.meta.url));

// Fixture input: file name -> text. `check` reads through `read`, so no
// fixture ever touches the working tree.
const FIXTURES: Record<string, string> = {
  'hit.css': '.a {\n  color: #da1e28;\n}\n',
  'exempt.css':
    'body {\n  /* canopy-allow-literal: document background */\n  background: #161616;\n}\n',
  'clean.css':
    '.a {\n  color: var(--canopy-text-primary);\n  font: inherit;\n  font-family: var(--canopy-font-mono);\n}\n',
  'unknown.css': '/* canopy-allow-literal: looks nicer */\n.a { color: #fff; }\n',
};
const fixture = (name: string) => path.join(ROOT, 'fixtures', name);
const read = (file: string) => FIXTURES[path.basename(file)];
const run = (names: string[], allowText: string, full = false) =>
  check(names.map(fixture), { full, allowText, read });

describe('stripComments', () => {
  it('blanks block and line comments and keeps the line count', () => {
    const text = 'a /* #fff\n #000 */ b\nc // #abc\nd';
    const out = stripComments(text);
    expect(out.split('\n')).toHaveLength(4);
    expect(out).not.toContain('#');
    expect(out).toContain('b');
  });

  it('keeps a URL and a quoted hex', () => {
    expect(stripComments('url(https://x.test/a)')).toBe('url(https://x.test/a)');
    expect(stripComments("color: '#78a9ff', // blue")).toContain("'#78a9ff'");
  });
});

describe('isLiteral', () => {
  it.each([
    'color: #fff;',
    'background: var(--cds-layer, #262626);',
    "border: '1px solid #525252',",
    "font-family: 'IBM Plex Mono', monospace;",
    'font: 12px sans-serif;',
    "fontFamily: 'IBM Plex Sans',",
  ])('flags %s', (line) => {
    expect(isLiteral(line)).toBe(true);
  });

  it.each([
    'font: inherit;',
    "fontFamily: 'inherit',",
    'font-family: var(--canopy-font-mono);',
    'font-size: 12px;',
    'font-weight: 600;',
    'color: var(--canopy-text-primary);',
    '<span>&#160;</span>',
  ])('passes %s', (line) => {
    expect(isLiteral(line)).toBe(false);
  });
});

describe('scan', () => {
  it('reports an unmarked literal with its line and text', () => {
    expect(scan(FIXTURES['hit.css']).hits).toEqual([{ line: 2, text: 'color: #da1e28;' }]);
  });

  it('ignores a literal inside a comment', () => {
    expect(scan('/* was #fff */\n.a { color: red; } // #000\n')).toEqual({ hits: [], exempt: [] });
  });

  it('exempts only the line after the marker, in any comment form', () => {
    const tsx = "// canopy-allow-literal: Carbon danger pair\ncolor: '#da1e28',\nfill: '#fff',\n";
    expect(scan(tsx)).toEqual({
      hits: [{ line: 3, text: "fill: '#fff'," }],
      exempt: [{ line: 2, reason: 'Carbon danger pair' }],
    });
    const jsx = "{/* canopy-allow-literal: @media print */}\n<i style={{ color: '#000' }} />\n";
    expect(scan(jsx).exempt).toEqual([{ line: 2, reason: '@media print' }]);
  });
});

describe('parseAllow', () => {
  it('reads file, reason and count', () => {
    const allow = parseAllow(
      'src/App.css: @media print: 3\nsrc/index.css: document background: 2\n'
    );
    expect([...allow]).toEqual([
      ['src/App.css: @media print', 3],
      ['src/index.css: document background', 2],
    ]);
  });

  it('rejects a reason outside the vocabulary and a malformed line', () => {
    expect(() => parseAllow('src/App.css: looks nicer: 1\n')).toThrow(/unknown reason/);
    expect(() => parseAllow('src/App.css document background\n')).toThrow(/malformed/);
  });

  it('keeps the vocabulary closed to the four reasons', () => {
    expect(REASONS).toEqual([
      'document background',
      '@media print',
      'widget prop default',
      'Carbon danger pair',
    ]);
  });
});

describe('check', () => {
  it('hit: fails listing file:line: text', () => {
    expect(run(['hit.css'], '').errors).toEqual(['fixtures/hit.css:2: color: #da1e28;']);
  });

  it('exempt and allowed: passes and prints the exempt line with its reason', () => {
    const result = run(['exempt.css'], 'fixtures/exempt.css: document background: 1\n');
    expect(result.errors).toEqual([]);
    expect(result.report).toEqual(['1 exempt', 'fixtures/exempt.css:3: document background']);
  });

  it('exempt but not in the allow file: fails', () => {
    expect(run(['exempt.css'], '').errors).toEqual([
      'not in chrome-literals.allow: fixtures/exempt.css: document background: 1',
    ]);
  });

  it('allow entry with no matching line: fails the full-set run only', () => {
    const allowText = 'fixtures/clean.css: @media print: 1\n';
    expect(run(['clean.css'], allowText, true).errors).toEqual([
      'chrome-literals.allow entry with no marked line: fixtures/clean.css: @media print: 1',
    ]);
    expect(run(['clean.css'], allowText).errors).toEqual([]);
  });

  it('a count that differs from the allow file fails the full-set run', () => {
    const allowText = 'fixtures/exempt.css: document background: 2\n';
    expect(run(['exempt.css'], allowText, true).errors).toEqual([
      'chrome-literals.allow says fixtures/exempt.css: document background: 2, found 1',
    ]);
    expect(run(['exempt.css'], allowText).errors).toEqual([]);
  });

  it('clean: passes with nothing exempt', () => {
    expect(run(['clean.css'], '', true)).toEqual({ errors: [], report: ['0 exempt'] });
  });

  it('rejects a marker reason outside the vocabulary', () => {
    expect(run(['unknown.css'], '').errors).toEqual([
      'fixtures/unknown.css:2: unknown canopy-allow-literal reason: looks nicer',
    ]);
  });

  it('an empty file set fails', () => {
    expect(run([], '').errors).toEqual(['no files to check']);
  });

  it('absolute argv matches its repo-relative entry', () => {
    const absolute = path.join(ROOT, 'src', 'index.css');
    expect(path.isAbsolute(absolute)).toBe(true);
    expect(keyOf(absolute)).toBe('src/index.css');
    const result = check([absolute], {
      full: true,
      allowText: 'src/index.css: document background: 1\n',
      read: () => FIXTURES['exempt.css'],
    });
    expect(result).toEqual({
      errors: [],
      report: ['1 exempt', 'src/index.css:3: document background'],
    });
  });
});

describe('defaults', () => {
  it('are the chrome files, resolved from the script and not the cwd', () => {
    expect(DEFAULT_FILES.every((file: string) => path.isAbsolute(file))).toBe(true);
    expect(DEFAULT_FILES.map(keyOf)).toEqual([
      'src/App.css',
      'src/index.css',
      'src/tools/correlation/correlation.css',
      'src/components/PvCombo.tsx',
    ]);
  });
});

describe('guarded trees', () => {
  // A throwaway repo root holding a workbench and a waveform tree, so the walk
  // is tested without touching the working tree.
  let root: string;
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'chrome-literals-'));
    put('src/workbench/workbench.css', '.wb {\n  color: #da1e28;\n}\n');
    put('src/workbench/sidebar/Sidebar.tsx', 'export const x = 1;\n');
    put('src/workbench/types.ts', 'export type T = 1;\n');
    put('src/workbench/Sidebar.test.tsx', "const c = '#ff0000';\n");
    put('src/workbench/__fixtures__/stubTool.ts', "export const colour = '#ff0000';\n");
    put('src/workbench/notes.md', '#fff\n');
    put('src/tools/waveform/waveform.css', '.wf { color: var(--canopy-text-primary); }\n');
    put('src/tools/waveform/App.tsx', "const c = '#ff0000';\n");
    put('src/plot/gestures.ts', 'export const g = 1;\n');
    put('src/plot/readoutDock.css', '.dock { color: var(--canopy-text-primary); }\n');
    put('src/plot/gestures.test.ts', "const c = '#ff0000';\n");
    put('src/annotations/index.ts', 'export {};\n');
    put('src/annotations/layer.css', '.ann { color: var(--canopy-text-primary); }\n');
    put('src/annotations/geometry/hit.ts', 'export const x = 1;\n');
    put('src/annotations/Overlay.tsx', 'export const y = 1;\n');
    put('src/annotations/geometry/hit.test.ts', "const c = '#ff0000';\n");
    put('src/annotations/Overlay.test.tsx', "const c = '#ff0000';\n");
    put('src/annotations/README.md', '#fff\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('guard the workbench, waveform, statistics, plot and annotations trees', () => {
    expect(GUARDED_TREES.map((tree: { dir: string }) => tree.dir)).toEqual([
      'src/workbench',
      'src/tools/waveform',
      'src/statistics',
      'src/plot',
      'src/annotations',
    ]);
  });

  it('walk workbench stylesheets and modules, but not its tests or fixtures', () => {
    expect(treeFiles(GUARDED_TREES[0], root)).toEqual([
      'src/workbench/sidebar/Sidebar.tsx',
      'src/workbench/types.ts',
      'src/workbench/workbench.css',
    ]);
  });

  it('walk only the waveform stylesheets', () => {
    expect(treeFiles(GUARDED_TREES[1], root)).toEqual(['src/tools/waveform/waveform.css']);
  });

  it('walk plot stylesheets and modules, but not its tests', () => {
    expect(treeFiles(GUARDED_TREES[3], root)).toEqual([
      'src/plot/gestures.ts',
      'src/plot/readoutDock.css',
    ]);
  });

  it('walk annotations stylesheets and modules, but not its tests', () => {
    expect(treeFiles(GUARDED_TREES[4], root)).toEqual([
      'src/annotations/Overlay.tsx',
      'src/annotations/geometry/hit.ts',
      'src/annotations/index.ts',
      'src/annotations/layer.css',
    ]);
  });

  it('the real defaults include the plot and annotations modules', () => {
    const keys = defaultFiles().map(keyOf);
    expect(keys).toContain('src/plot/geometry.ts');
    expect(keys).toContain('src/annotations/model.ts');
  });

  it('an absent tree contributes nothing', () => {
    expect(treeFiles({ dir: 'src/nowhere', include: /\.css$/, exclude: null }, root)).toEqual([]);
  });

  it('a hex literal in a workbench stylesheet fails the no-argument run', () => {
    const files = defaultFiles(root);
    expect(files).toContain(path.join(root, 'src/workbench/workbench.css'));
    const walked = files.filter((file: string) => file.startsWith(root));
    const result = check(walked, { full: true, allowText: '' });
    expect(result.errors.map((line: string) => line.replace(/^.*?src\//, 'src/'))).toEqual([
      'src/workbench/workbench.css:2: color: #da1e28;',
    ]);
  });

  it('the real defaults include every workbench production file', () => {
    const keys = defaultFiles().map(keyOf);
    expect(keys.slice(0, DEFAULT_FILES.length)).toEqual(DEFAULT_FILES.map(keyOf));
    expect(keys).toEqual(expect.arrayContaining(treeFiles(GUARDED_TREES[0])));
    expect(keys.some((key: string) => /\.test\.tsx?$/.test(key))).toBe(false);
  });
});

describe('workbench import allow-list (lint)', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const denied = async (code: string, file: string) => {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
    return result.messages
      .filter((m) => m.ruleId === 'workbench/import-allowlist')
      .map((m) => m.message.split("'")[1]);
  };

  it('rejects tool code imported from the workbench', async () => {
    const code = [
      "import { traceTool } from '../tools/trace/tool';",
      "import { dot } from '../tools/dotHelpers';",
      "import { Plot as CorrelationPlot } from '../tools/correlation/Plot';",
      "import { Plot } from '../tools/waveform/Plot';",
      "import { PlotArea } from '../components/PlotArea';",
      "import * as echarts from 'echarts';",
      "export { x } from '../tools/codeFragment';",
      "export const lazy = () => import('../tools/trace/tool');",
    ].join('\n');
    expect(await denied(code, 'src/workbench/Probe.tsx')).toEqual([
      '../tools/trace/tool',
      '../tools/dotHelpers',
      '../tools/correlation/Plot',
      '../tools/waveform/Plot',
      '../components/PlotArea',
      'echarts',
      '../tools/codeFragment',
      '../tools/trace/tool',
    ]);
  });

  it('accepts the allow-list from any depth', async () => {
    const code = [
      "import { useState } from 'react';",
      "import { jsx } from 'react/jsx-runtime';",
      "import { Button } from '@carbon/react';",
      "import { Add } from '@carbon/icons-react';",
      "import { DndContext } from '@dnd-kit/core';",
      "import { Panel } from 'react-resizable-panels';",
      "import { TESTIDS } from '../testids';",
      "import './inspector.css';",
      "import { PvCombo } from '../../components/PvCombo';",
      "import type { PvSearch } from '../../pvSearch';",
      "import { matchChannels } from '../../pvSearch/fuzzy';",
      "import { usePVSearch } from '../../pvSearch/usePVSearch';",
    ].join('\n');
    expect(await denied(code, 'src/workbench/inspector/Inspector.tsx')).toEqual([]);
  });

  it('lets tests and fixtures use the shared dot helpers and code formatter only', async () => {
    const code = [
      "import { describe } from 'vitest';",
      "import { render } from '@testing-library/react';",
      "import { dot } from '../tools/dotHelpers';",
      "import { fmt } from '../tools/codeFragment.ts';",
      "import { traceTool } from '../tools/trace/tool';",
    ].join('\n');
    expect(await denied(code, 'src/workbench/Outline.test.tsx')).toEqual(['../tools/trace/tool']);
    expect(
      await denied(code.replaceAll('../', '../../'), 'src/workbench/__fixtures__/stubTool.ts')
    ).toEqual(['../../tools/trace/tool']);
    expect(await denied(code, 'src/workbench/Outline.tsx')).toEqual([
      'vitest',
      '@testing-library/react',
      '../tools/dotHelpers',
      '../tools/codeFragment.ts',
      '../tools/trace/tool',
    ]);
  });

  it('leaves code outside the workbench alone', async () => {
    expect(await denied("import { traceTool } from './tools/trace/tool';", 'src/App.tsx')).toEqual(
      []
    );
  });
});

describe('command line', () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: '/' });

  it('a glob matching no files exits 1', () => {
    const result = cli(path.join(ROOT, 'src', 'no-such-dir', '*.css'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no files to check');
  });

  it('a missing named file exits 1', () => {
    const result = cli(path.join(ROOT, 'src', 'no-such-file.css'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no such file');
  });

  it('a file without literals exits 0 and prints the exempt count', () => {
    const result = cli(path.join(ROOT, 'scripts', 'chrome-literals.allow'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('0 exempt\n');
  });
});

// Ordinary TypeScript and CSS must not be mistaken for a style literal; a real
// one must still be found. `scan` is given the syntax of the file, as `check`
// does from its extension.
const lit = (text: string, kind: string, fontSize = false) =>
  scan(text, { kind, fontSize }).hits.map((hit: { line: number }) => hit.line);

describe('kindOf', () => {
  it('reads the syntax from the extension', () => {
    expect(kindOf('a/App.css')).toBe('css');
    expect(kindOf('a/Panel.tsx')).toBe('tsx');
    expect(kindOf('a/Panel.jsx')).toBe('tsx');
    expect(kindOf('a/model.ts')).toBe('ts');
    expect(kindOf('a/script.mjs')).toBe('ts');
    expect(kindOf('scripts/chrome-literals.allow')).toBeUndefined();
  });
});

describe('TypeScript: only string literals and style objects are scanned', () => {
  it.each([
    ['a type annotation', 'interface X { font: string; fontFamily: string }'],
    ['a font size type', 'interface X { fontSize: number }'],
    ['a ternary', 'const f = bold ? font : other;'],
    ['a chart option number', 'const o = { textStyle: { fontSize: 12 } };'],
    ['an object key named like a font', "const label = { fontSize: 'inherit' };"],
    ['a string that only names a property', "const label = 'fontSize: 12';"],
    ['a fragment link', 'const a = <a href="#a11">top</a>;'],
    ['an aria reference', 'const a = <div aria-controls="#feed" id="#abc" />;'],
    ['a selector lookup', "document.querySelector('#abc');"],
    ['a selector list', "el.closest('#add, #bad');"],
    ['an element lookup', "document.getElementById('#fade');"],
    ['an id selector in matches', "el.matches('#dad');"],
    ['a private field', 'class A { #bad = 1; get() { return this.#bad; } }'],
    ['an issue number in an error', "throw new Error('see issue #123');"],
    ['an issue number in prose', "const note = 'see issue #123 for details';"],
    ['a hex-like object key', "const m = { '#fed': 1 };"],
    ['a hex-like lookup key', "const v = m['#fed'];"],
    ['a string literal type', "type Id = '#abc' | '#fed';"],
    ['an import path', "import x from './pages/#abc';"],
    ['a character entity', 'const s = <span>&#160;</span>;'],
    ['a console message', "console.warn('colour #fff is not allowed');"],
    ['JSX text', 'const p = <p>use #fff or #000</p>;'],
  ])('passes %s', (_name, code) => {
    expect(lit(code, 'tsx', true)).toEqual([]);
  });

  it('ignores a comment after an apostrophe in JSX text', () => {
    expect(lit("const p = <p>Don't</p>; /* was #fff */\n", 'tsx')).toEqual([]);
  });

  it('ignores a comment after a backtick inside a regular expression', () => {
    expect(lit('const r = /`/;\n// colour was #fff\nconst z = 1;\n', 'ts')).toEqual([]);
  });

  it('ignores a hex colour in a comment', () => {
    expect(lit('// #fff\n/* #000 */\nconst a = 1;\n', 'ts')).toEqual([]);
  });

  it.each([
    ['a colour string', "const c = '#ff0000';"],
    ['a colour key', "const o = { color: '#fff' };"],
    ['a JSX colour attribute', 'const a = <rect fill="#fff" />;'],
    ['a style object', "const a = <i style={{ borderColor: '#da1e28' }} />;"],
    ['a colour in a value', "const o = { border: '1px solid #525252' };"],
    ['a colour inside a template', 'const o = `1px solid #525252 ${x}`;'],
    ['a var fallback', "const o = { color: 'var(--cds-layer, #262626)' };"],
    ['a colour in a JSON string', 'const j = \'{"color":"#fff"}\';'],
    ['a CSS declaration in a string', "const css = 'color: #fff; margin: 0';"],
    ['a font family', "const o = { fontFamily: 'IBM Plex Sans' };"],
    ['a font shorthand', "const o = { font: '12px sans-serif' };"],
    ['a font family in a CSS string', "const css = 'font-family: Arial';"],
  ])('flags %s', (_name, code) => {
    expect(lit(code, 'tsx')).toEqual([1]);
  });

  it('flags a font size or font family that is not a contract value, in a style object', () => {
    expect(lit('const a = <i style={{ fontSize: 12 }} />;', 'tsx', true)).toEqual([1]);
    expect(lit('const a = <i style={{ fontFamily: FONT }} />;', 'tsx')).toEqual([1]);
    expect(lit("const o = { fontSize: '12px' };", 'ts', true)).toEqual([1]);
    expect(lit("const o = { fontSize: '12px' };", 'ts')).toEqual([]);
  });

  it('passes the contract fonts and sizes, and inherit', () => {
    const code = [
      "const a = <i style={{ fontFamily: 'var(--canopy-font-mono)', fontSize: 'var(--canopy-text-sm)' }} />;",
      "const b = { font: 'inherit', fontFamily: `var(--canopy-font-sans), ${x}` };",
    ].join('\n');
    expect(lit(code, 'tsx', true)).toEqual([]);
  });

  it('reports the line of a literal inside a multi-line template', () => {
    expect(lit('const css = `\n  a {\n    color: #fff;\n  }\n`;\n', 'ts')).toEqual([3]);
  });

  it('honours the marker on the line before', () => {
    const code = "// canopy-allow-literal: Carbon danger pair\nconst c = '#da1e28';\n";
    expect(scan(code, { kind: 'ts' })).toEqual({
      hits: [],
      exempt: [{ line: 2, reason: 'Carbon danger pair' }],
    });
  });
});

describe('CSS: only declaration values are scanned', () => {
  it.each([
    ['an id selector', '#feed {\n  margin: 0;\n}\n'],
    ['an id selector with a pseudo-class', 'a#add:hover,\n#bad > .x {\n  margin: 0;\n}\n'],
    ['a fragment reference', '.m {\n  mask: url(#fade);\n  filter: url(#dad);\n}\n'],
    ['a quoted string', '.m::after {\n  content: "#fed";\n}\n'],
    ['a contract colour', '.m {\n  color: var(--canopy-text-primary);\n}\n'],
  ])('passes %s', (_name, css) => {
    expect(lit(css, 'css')).toEqual([]);
  });

  it('flags a hex colour in a declaration, and in a one-line rule', () => {
    expect(lit('.a {\n  color: #da1e28;\n}\n', 'css')).toEqual([2]);
    expect(lit('#feed { color: #fff }\n', 'css')).toEqual([1]);
    expect(lit('.a {\n  --accent: #0f62fe;\n}\n', 'css')).toEqual([2]);
  });

  it('flags a hex colour fallback and a value that spans lines', () => {
    expect(lit('.a {\n  color: var(--cds-text, #262626);\n}\n', 'css')).toEqual([2]);
    expect(
      lit('.a {\n  box-shadow:\n    0 0 1px var(--x),\n    0 0 2px #000;\n}\n', 'css')
    ).toEqual([4]);
  });

  it('flags a non-contract font, and a font size only where it is gated', () => {
    expect(lit('.a {\n  font-family: Arial;\n}\n', 'css')).toEqual([2]);
    expect(lit('.a {\n  font-size: 12px;\n}\n', 'css')).toEqual([]);
    expect(lit('.a {\n  font-size: 12px;\n}\n', 'css', true)).toEqual([2]);
    expect(
      lit('.a {\n  font: inherit;\n  font-family: var(--canopy-font-mono);\n}\n', 'css', true)
    ).toEqual([]);
  });

  it('ignores a comment', () => {
    expect(lit('/* color: #fff */\n.a { margin: 0; } /* #000 */\n', 'css')).toEqual([]);
  });
});

describe('check reads the syntax from the extension', () => {
  const files: Record<string, string> = {
    'Link.tsx': 'export const A = () => <a href="#a11">top</a>;\n',
    'Dot.tsx': "export const c = '#ff0000';\n",
    'ids.css': '#feed {\n  margin: 0;\n}\n',
  };
  const go = (name: string) =>
    check([fixture(name)], {
      full: false,
      allowText: '',
      read: (file: string) => files[path.basename(file)],
    });

  it('passes a fragment link and an id selector', () => {
    expect(go('Link.tsx').errors).toEqual([]);
    expect(go('ids.css').errors).toEqual([]);
  });

  it('fails a colour string', () => {
    expect(go('Dot.tsx').errors).toEqual(["fixtures/Dot.tsx:1: export const c = '#ff0000';"]);
  });
});

describe('command line, by file type', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'chrome-literals-cli-'));
    writeFileSync(path.join(dir, 'ok.tsx'), 'export const A = () => <a href="#a11">top</a>;\n');
    writeFileSync(path.join(dir, 'bad.tsx'), "export const c = '#ff0000';\n");
    writeFileSync(path.join(dir, 'ids.css'), '#feed {\n  margin: 0;\n}\n');
    writeFileSync(path.join(dir, 'bad.css'), '.a {\n  color: #da1e28;\n}\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (name: string) =>
    spawnSync(process.execPath, [SCRIPT, path.join(dir, name)], { encoding: 'utf8', cwd: '/' });

  it('exits 0 for an id fragment and an id selector', () => {
    expect(cli('ok.tsx').status).toBe(0);
    expect(cli('ids.css').status).toBe(0);
  });

  it('exits 1 for a hex colour in a string and in a declaration', () => {
    expect(cli('bad.tsx').status).toBe(1);
    expect(cli('bad.css').status).toBe(1);
  });
});
