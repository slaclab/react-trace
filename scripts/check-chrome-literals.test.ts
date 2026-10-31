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
      'src/index.css',
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
