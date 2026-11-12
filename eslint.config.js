import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** True when `spec` names `pkg` (or a subpath of it); `@scope/*` matches the whole scope. */
function packageMatches(spec, pkg) {
  if (pkg.endsWith('/*')) return spec.startsWith(pkg.slice(0, -1));
  return spec === pkg || spec.startsWith(`${pkg}/`);
}

/** The repo-relative module a relative specifier points at, without a script extension. */
function resolveRelative(filename, spec) {
  const abs = path.resolve(path.dirname(filename), spec);
  return path
    .relative(ROOT, abs)
    .split(path.sep)
    .join('/')
    .replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

/**
 * An ESLint rule that limits what a file may import. A relative import must
 * resolve under one of `trees` (repo-relative prefixes ending in `/`) or to
 * one of `modules` (repo-relative, without extension); a package import must
 * match one of `packages`, or anything when `packages` is null. Test files
 * (`isTest`) get `tests` instead: null exempts them, an object adds `trees`,
 * `modules` and `packages` to the lists and `note` to the message.
 * Every import form is checked: static imports, re-exports, `import()` with
 * a literal and `import x = require()`.
 */
function importAllowlistRule({ description, message, trees, modules, packages, isTest, tests }) {
  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [],
      messages: { denied: `'{{spec}}' ${message}{{note}}` },
    },
    create(context) {
      const filename = context.filename;
      const rel = path.relative(ROOT, filename).split(path.sep).join('/');
      const test = isTest(rel);
      if (test && tests === null) return {};
      const extra = test ? tests : { trees: [], modules: [], packages: [], note: '' };
      const allowedTrees = [...trees, ...(extra.trees ?? [])];
      const allowedModules = [...modules, ...(extra.modules ?? [])];
      const allowedPackages = packages === null ? null : [...packages, ...(extra.packages ?? [])];

      function allowed(spec) {
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const target = resolveRelative(filename, spec);
          return (
            allowedTrees.some((tree) => target.startsWith(tree)) || allowedModules.includes(target)
          );
        }
        return allowedPackages === null || allowedPackages.some((pkg) => packageMatches(spec, pkg));
      }

      function checkSource(source) {
        if (!source || typeof source.value !== 'string') return;
        if (allowed(source.value)) return;
        context.report({
          node: source,
          messageId: 'denied',
          data: { spec: source.value, note: extra.note ?? '' },
        });
      }

      return {
        ImportDeclaration: (node) => checkSource(node.source),
        ExportNamedDeclaration: (node) => checkSource(node.source),
        ExportAllDeclaration: (node) => checkSource(node.source),
        ImportExpression: (node) => {
          if (node.source.type === 'Literal') checkSource(node.source);
        },
        TSImportEqualsDeclaration: (node) => {
          if (node.moduleReference.type === 'TSExternalModuleReference')
            checkSource(node.moduleReference.expression);
        },
      };
    },
  };
}

const isTestModule = (rel) => /\.test\.[cm]?[jt]sx?$/.test(rel);

// The workbench owns layout, settings and actions chrome only; it must never
// reach into a tool. A module under src/workbench/ may import the workbench
// itself, the shared PV field (src/components/PvCombo and src/pvSearch) and
// a short list of packages. Its tests and its own fixtures may additionally
// use the test runner and the two tool-side helpers the stub tool is built
// from; no other tool code.
const workbenchImportAllowlist = importAllowlistRule({
  description: 'src/workbench/** imports only its allow-list, never tool code',
  message:
    'is not on the workbench import allow-list (react, @carbon/*, @dnd-kit/*, react-resizable-panels, src/workbench/**, the shared PV field)',
  trees: ['src/workbench/', 'src/pvSearch/'],
  modules: ['src/components/PvCombo', 'src/pvSearch'],
  packages: ['react', '@carbon/*', '@dnd-kit/*', 'react-resizable-panels'],
  isTest: (rel) => isTestModule(rel) || rel.startsWith('src/workbench/__fixtures__/'),
  tests: {
    modules: ['src/tools/dotHelpers', 'src/tools/codeFragment'],
    packages: ['vitest', '@testing-library/*'],
    note: '; tests and fixtures also: vitest, @testing-library/*, src/tools/dotHelpers, src/tools/codeFragment',
  },
});

// The plot interaction layer: a production module under src/plot/ (gestures,
// projection, strip toggles, read-out dock, PNG capture) is shared by every
// plot tool and imports only itself and third-party packages. It never
// reaches into the drawing core or a tool. Tests are exempt.
const plotImportAllowlist = importAllowlistRule({
  description: 'src/plot/** (non-test) imports only the plot interaction layer and packages',
  message:
    "is outside the plot interaction layer's import allow-list (src/plot/**, third-party packages); drawing code belongs in src/annotations/, tool code in src/tools/.",
  trees: ['src/plot/'],
  modules: [],
  packages: null,
  isTest: isTestModule,
  tests: null,
});

// The drawing core: a production module under src/annotations/ imports only
// the core itself, the plot interaction layer (src/plot/), the shared panels
// (src/workbench/), generic math (src/statistics/) and third-party packages;
// everything Trace-only lives in src/tools/trace/drawing/. The one named
// exception is src/annotationTheme, the source of the drawing colours:
// src/annotations is literal-guarded (scripts/check-chrome-literals.mjs), so
// the palette's colour values cannot live inside the tree. Tests and fixtures
// are exempt, because the Trace contract tests render SinglePlot.
const annotationsImportAllowlist = importAllowlistRule({
  description:
    'src/annotations/** (non-test) imports only the drawing core, src/plot, src/workbench, src/statistics and packages',
  message:
    "is outside the drawing core's import allow-list (src/annotations/**, src/plot/**, src/workbench/**, src/statistics/**, src/annotationTheme, third-party packages); Trace-only code belongs in src/tools/trace/drawing/.",
  trees: ['src/annotations/', 'src/plot/', 'src/workbench/', 'src/statistics/'],
  modules: ['src/annotationTheme'],
  packages: null,
  isTest: (rel) => isTestModule(rel) || rel.includes('/__fixtures__/'),
  tests: null,
});

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { tsconfigRootDir: ROOT },
    },
  },
  {
    files: ['src/workbench/**/*.{ts,tsx,js,jsx}'],
    plugins: { workbench: { rules: { 'import-allowlist': workbenchImportAllowlist } } },
    rules: { 'workbench/import-allowlist': 'error' },
  },
  {
    files: ['src/plot/**/*.{ts,tsx,js,jsx}'],
    plugins: { plot: { rules: { 'import-allowlist': plotImportAllowlist } } },
    rules: { 'plot/import-allowlist': 'error' },
  },
  {
    files: ['src/annotations/**/*.{ts,tsx,js,jsx}'],
    plugins: { annotations: { rules: { 'import-allowlist': annotationsImportAllowlist } } },
    rules: { 'annotations/import-allowlist': 'error' },
  },
]);
