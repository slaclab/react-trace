import { describe, it, expect, vi } from 'vitest';

import { capturePlots, capturedToFile, type PngSource } from './exportPlotImage';

// 1x1 transparent PNG.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDJ/3J3AAAAAElFTkSuQmCC';

function fakeInstance(dataUrl: string): PngSource {
  return { getDataURL: () => Promise.resolve(dataUrl) };
}

describe('capturePlots', () => {
  it('captures instances and skips plots without one', async () => {
    const captured = await capturePlots(
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

  it('bakes in the background at pixel ratio 2', async () => {
    const getDataURL = vi.fn(() => Promise.resolve(PNG_DATA_URL));
    await capturePlots([{ id: 'p1', title: 'Plot 1', instance: { getDataURL } }], '#f4f4f4');
    expect(getDataURL).toHaveBeenCalledWith({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: '#f4f4f4',
    });
  });

  it('skips instances that yield no image or throw', async () => {
    const captured = await capturePlots(
      [
        { id: 'empty', title: 'Empty', instance: fakeInstance('') },
        { id: 'bad', title: 'Bad', instance: fakeInstance('not a data url') },
        {
          id: 'throws',
          title: 'Throws',
          instance: {
            getDataURL: () => {
              throw new Error('disposed');
            },
          },
        },
        { id: 'ok', title: 'OK', instance: fakeInstance(PNG_DATA_URL) },
      ],
      '#161616'
    );
    expect(captured.map((c) => c.id)).toEqual(['ok']);
  });
});

describe('capturePlots (async sources)', () => {
  it('awaits each source and skips empty or failed captures', async () => {
    const captured = await capturePlots(
      [
        { id: 'p1', title: 'Plot 1', instance: { getDataURL: () => Promise.resolve('') } },
        {
          id: 'p2',
          title: 'Plot 2',
          instance: { getDataURL: () => Promise.reject(new Error('x')) },
        },
        { id: 'p3', title: 'Plot 3', instance: fakeInstance(PNG_DATA_URL) },
      ],
      '#161616'
    );
    expect(captured.map((c) => c.id)).toEqual(['p3']);
  });
});

describe('capturedToFile', () => {
  it('builds a sanitized, indexed png filename', () => {
    const file = capturedToFile({ id: 'p1', title: 'Beam Current (mA)', dataUrl: PNG_DATA_URL }, 0);
    expect(file.name).toBe('trace_plot_1_Beam_Current_mA.png');
    expect(file.type).toBe('image/png');
  });

  it('decodes the PNG bytes into the file', async () => {
    const file = capturedToFile({ id: 'p1', title: 'Plot', dataUrl: PNG_DATA_URL }, 0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    // PNG magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('falls back to the id when the title has no usable characters', () => {
    const file = capturedToFile({ id: 'plot-xyz', title: '!!!', dataUrl: PNG_DATA_URL }, 2);
    expect(file.name).toBe('trace_plot_3_plot-xyz.png');
  });
});
