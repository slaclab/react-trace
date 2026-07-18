import { describe, it, expect } from 'vitest';

import { dataUrlToBlob, capturePlots, capturedToFile, type PngSource } from './exportPlotImage';

// 1x1 transparent PNG.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDJ/3J3AAAAAElFTkSuQmCC';

function fakeInstance(dataUrl: string): PngSource {
  return { getDataURL: () => dataUrl };
}

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL into a Blob with the right mime', async () => {
    const blob = dataUrlToBlob(PNG_DATA_URL);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // PNG magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('capturePlots', () => {
  it('captures instances and skips plots without one', () => {
    const captured = capturePlots(
      [
        { id: 'p1', title: 'Plot 1', instance: fakeInstance(PNG_DATA_URL) },
        { id: 'p2', title: 'Plot 2', instance: null },
        { id: 'p3', title: 'Plot 3', instance: undefined },
      ],
      '#161616'
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ id: 'p1', title: 'Plot 1', dataUrl: PNG_DATA_URL });
  });
});

describe('capturedToFile', () => {
  it('builds a sanitized, indexed png filename', () => {
    const file = capturedToFile({ id: 'p1', title: 'Beam Current (mA)', dataUrl: PNG_DATA_URL }, 0);
    expect(file.name).toBe('trace_plot_1_Beam_Current_mA.png');
    expect(file.type).toBe('image/png');
  });

  it('falls back to the id when the title has no usable characters', () => {
    const file = capturedToFile({ id: 'plot-xyz', title: '!!!', dataUrl: PNG_DATA_URL }, 2);
    expect(file.name).toBe('trace_plot_3_plot-xyz.png');
  });
});
