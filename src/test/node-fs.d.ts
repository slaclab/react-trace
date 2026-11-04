// Tests that read a source file run in Node; only this much of node:fs is used.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
