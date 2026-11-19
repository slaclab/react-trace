// Duplicate-package guard for the build: React and Carbon keep state in module
// scope, so a second copy in the bundle (a linked SDK package resolving its own)
// breaks hooks and context at runtime without failing the build.

const GUARDED = /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|@carbon\/react)\//;

/** Map each guarded package name to the real directories its bundled modules come from. */
export function packageDirs(
  moduleIds: Iterable<string>,
  realpath: (path: string) => string
): Map<string, Set<string>> {
  const dirs = new Map<string, Set<string>>();
  for (const id of moduleIds) {
    // Virtual ids wrap a real path: "\0<path>?commonjs-module".
    const path = id.replace(/^\0/, '').replace(/[?#].*$/, '');
    const match = GUARDED.exec(path);
    if (!match) continue;
    let dir = path.slice(0, match.index + match[0].length - 1);
    try {
      dir = realpath(dir);
    } catch {
      // Not on disk: compare the directory as written.
    }
    const name = match[2];
    dirs.set(name, (dirs.get(name) ?? new Set()).add(dir));
  }
  return dirs;
}

/** Throw `duplicate <name>: <dirs>` when a guarded package is bundled from more than one directory. */
export function assertSinglePackageDirs(
  moduleIds: Iterable<string>,
  realpath: (path: string) => string
): void {
  for (const [name, dirs] of packageDirs(moduleIds, realpath)) {
    if (dirs.size > 1) throw new Error(`duplicate ${name}: ${[...dirs].sort().join(', ')}`);
  }
}
