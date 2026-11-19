import { describe, expect, it } from 'vitest';
import { assertSinglePackageDirs, packageDirs } from './vite.dupGuard';

const same = (p: string) => p;
const trace = '/trace/node_modules/.pnpm';
const sdk = '/sdk/node_modules/.pnpm';

describe('packageDirs', () => {
  it('maps guarded module ids to their package directory', () => {
    const dirs = packageDirs(
      [
        `${trace}/react@19.2.6/node_modules/react/index.js`,
        `${trace}/react@19.2.6/node_modules/react/cjs/react.production.js`,
        `${trace}/react-dom@19.2.6_react@19.2.6/node_modules/react-dom/client.js`,
        `${trace}/@carbon+react@1.108.0_x/node_modules/@carbon/react/es/index.js`,
        '/trace/node_modules/react/jsx-runtime.js',
        '/trace/src/main.tsx',
        `${trace}/react-is@19.0.0/node_modules/react-is/index.js`,
      ],
      same
    );
    expect(dirs).toEqual(
      new Map([
        [
          'react',
          new Set([`${trace}/react@19.2.6/node_modules/react`, '/trace/node_modules/react']),
        ],
        ['react-dom', new Set([`${trace}/react-dom@19.2.6_react@19.2.6/node_modules/react-dom`])],
        ['@carbon/react', new Set([`${trace}/@carbon+react@1.108.0_x/node_modules/@carbon/react`])],
      ])
    );
  });

  it('resolves symlinked directories through realpath', () => {
    const real = (p: string) =>
      p === '/trace/node_modules/react' ? `${trace}/react@19.2.6/node_modules/react` : p;
    const dirs = packageDirs(
      ['/trace/node_modules/react/index.js', `${trace}/react@19.2.6/node_modules/react/index.js`],
      real
    );
    expect([...dirs.get('react')!]).toEqual([`${trace}/react@19.2.6/node_modules/react`]);
  });

  it('reads the path of a virtual module id and ignores its query', () => {
    const dirs = packageDirs(
      [
        `\0${trace}/react@19.2.6/node_modules/react/index.js?commonjs-module`,
        `${trace}/react@19.2.6/node_modules/react/index.js`,
      ],
      same
    );
    expect([...dirs.get('react')!]).toEqual([`${trace}/react@19.2.6/node_modules/react`]);
  });

  it('keeps the unresolved directory when realpath fails', () => {
    const dirs = packageDirs(['/gone/node_modules/react/index.js'], () => {
      throw new Error('ENOENT');
    });
    expect([...dirs.get('react')!]).toEqual(['/gone/node_modules/react']);
  });
});

describe('assertSinglePackageDirs', () => {
  it('passes when every guarded package has one directory', () => {
    expect(() =>
      assertSinglePackageDirs(
        [
          `${trace}/react@19.2.6/node_modules/react/index.js`,
          `${trace}/react-dom@19.2.6_react@19.2.6/node_modules/react-dom/client.js`,
          `${trace}/@carbon+react@1.108.0_x/node_modules/@carbon/react/es/index.js`,
        ],
        same
      )
    ).not.toThrow();
  });

  it('passes when the bundle has none of the guarded packages', () => {
    expect(() => assertSinglePackageDirs(['/trace/src/main.tsx'], same)).not.toThrow();
  });

  it('throws naming the package and both directories', () => {
    expect(() =>
      assertSinglePackageDirs(
        [
          `${trace}/react@19.2.6/node_modules/react/index.js`,
          `${sdk}/react@19.2.6/node_modules/react/index.js`,
        ],
        same
      )
    ).toThrow(
      `duplicate react: ${sdk}/react@19.2.6/node_modules/react, ${trace}/react@19.2.6/node_modules/react`
    );
  });

  it('throws for a second @carbon/react', () => {
    expect(() =>
      assertSinglePackageDirs(
        [
          `${trace}/@carbon+react@1.108.0_x/node_modules/@carbon/react/es/index.js`,
          `${sdk}/@carbon+react@1.111.0_x/node_modules/@carbon/react/es/index.js`,
        ],
        same
      )
    ).toThrow(/^duplicate @carbon\/react: /);
  });
});
