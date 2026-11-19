// The page start shared by every entry: stylesheet order, then the host-sheet
// fallback, the colour mode, then the bridge when embedded.

import { afterEach, describe, expect, it, vi } from 'vitest';
import bootstrapRaw from './bootstrap.ts?raw';

const calls: string[] = [];
const embedded = { value: false };

vi.mock('@slaclab/canopy-shell', () => ({
  applyHostSheetFallback: () => calls.push('applyHostSheetFallback'),
}));
vi.mock('./embed/embedded', () => ({ isEmbedded: () => embedded.value }));
vi.mock('./state/colorMode', () => ({ setupColorMode: () => calls.push('setupColorMode') }));
vi.mock('./embed/bridge', () => ({ installBridge: () => calls.push('installBridge') }));

async function runBootstrap(isEmbedded: boolean): Promise<string[]> {
  calls.length = 0;
  embedded.value = isEmbedded;
  vi.resetModules();
  await import('./bootstrap');
  return [...calls];
}

afterEach(() => {
  embedded.value = false;
});

describe('bootstrap', () => {
  it('imports Carbon, the shell styles, its host-contract sheet, then the app chrome', () => {
    const sheets = [...bootstrapRaw.matchAll(/^import\s+'([^']+)';$/gm)].map((m) => m[1]);
    expect(sheets).toEqual([
      './index.scss',
      '@slaclab/canopy-shell/styles.css',
      '@slaclab/canopy-shell/host-contract.css',
      './index.css',
    ]);
  });

  it('applies the host-sheet fallback and the colour mode, no bridge, when standalone', async () => {
    expect(await runBootstrap(false)).toEqual(['applyHostSheetFallback', 'setupColorMode']);
  });

  it('applies the fallback first and installs the bridge last when embedded', async () => {
    expect(await runBootstrap(true)).toEqual([
      'applyHostSheetFallback',
      'setupColorMode',
      'installBridge',
    ]);
  });
});
