#!/usr/bin/env node
// Build-output guard: Trace must be fully self-hosted. It is served on
// networks without internet access, so no file in dist/ may point at an
// external font CDN (IBM's s81c.com, which the precompiled Carbon CSS uses,
// or Google Fonts). Every @font-face must also declare `font-display: swap`,
// so text shows in a fallback font while IBM Plex loads instead of staying
// invisible. No .woff file may ship either: every browser and WebView Trace
// targets loads woff2, so a .woff fallback is dead weight in the container
// image and the Tauri bundle. Run after `vite build`; exits non-zero on any
// problem.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Host fragments that mark a font fetched from the internet. */
export const FORBIDDEN = ['s81c.com', 'fonts.googleapis', 'fonts.gstatic'];

/** The FORBIDDEN entries that occur in `text`, in list order. */
export function findHits(text) {
  return FORBIDDEN.filter((needle) => text.includes(needle));
}

/** The `@font-face { ... }` blocks in `css`, in order. */
export function findFontFaces(css) {
  return css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
}

/** The @font-face blocks in `css` that do not declare `font-display: swap`. */
export function facesWithoutSwap(css) {
  return findFontFaces(css).filter((face) => !/font-display\s*:\s*swap\b/.test(face));
}

/** The paths in `paths` that are `.woff` fonts (`.woff2` is fine). */
export function findWoffFiles(paths) {
  return paths.filter((path) => /\.woff$/i.test(path));
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function main() {
  const distDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

  let files;
  try {
    files = [...walk(distDir)];
  } catch (err) {
    console.error(`check-dist: cannot read ${distDir}: ${err.message}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`check-dist: ${distDir} is empty; run the build first`);
    process.exit(2);
  }

  const hits = [];
  const noSwap = [];
  let faces = 0;
  for (const file of files) {
    // latin1 keeps binary files (fonts, images) scannable byte-for-byte.
    const text = readFileSync(file, 'latin1');
    for (const needle of findHits(text)) hits.push(`${relative(distDir, file)}: ${needle}`);
    if (file.endsWith('.css')) {
      faces += findFontFaces(text).length;
      const missing = facesWithoutSwap(text).length;
      if (missing > 0) noSwap.push(`${relative(distDir, file)}: ${missing} @font-face rules`);
    }
  }

  let failed = false;
  if (hits.length > 0) {
    console.error('check-dist: external font references found in the build output:');
    for (const hit of hits) console.error(`  ${hit}`);
    failed = true;
  }
  // Zero faces means the self-hosted fonts were dropped; the swap check below
  // would then pass without checking anything.
  if (faces === 0) {
    console.error('check-dist: no @font-face rules in the built CSS; IBM Plex is not self-hosted');
    failed = true;
  }
  const woff = findWoffFiles(files.map((file) => relative(distDir, file)));
  if (woff.length > 0) {
    console.error('check-dist: .woff fonts in the build output (woff2 only is expected):');
    for (const path of woff) console.error(`  ${path}`);
    failed = true;
  }
  if (noSwap.length > 0) {
    console.error('check-dist: @font-face rules without font-display: swap:');
    for (const line of noSwap) console.error(`  ${line}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`check-dist: ${files.length} files clean`);
}

// Importing this module (the unit test does) must not walk dist or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
