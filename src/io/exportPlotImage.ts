import { dataUrlToBlob } from '@slaclab/canopy-charts';

// Capture ECharts plots as PNG blobs for e-log attachments. We only need the
// `getDataURL` slice of the ECharts instance, so we type against that to avoid
// pulling the full echarts type surface through every caller.
export interface PngSource {
  getDataURL(opts?: {
    type?: 'png' | 'jpeg' | 'svg';
    pixelRatio?: number;
    backgroundColor?: string;
  }): Promise<string>;
}

export interface CapturedPlot {
  id: string;
  title: string;
  dataUrl: string;
}

const PIXEL_RATIO = 2;

// Capture each plot as its own PNG data URL: pixel ratio 2, the given
// background baked in, the plot's drawings composed on top by its source.
// Skips plots that yield no image (detached/unmounted, disposed, not yet
// rendered, or an ECharts error) rather than aborting the batch or attaching
// a broken image, the rule canopy-charts' captureChartPng applies to a bare
// chart.
export async function capturePlots(
  plots: { id: string; title: string; instance: PngSource | null | undefined }[],
  backgroundColor: string
): Promise<CapturedPlot[]> {
  const out: CapturedPlot[] = [];
  for (const p of plots) {
    if (!p.instance) continue;
    let dataUrl: string;
    try {
      dataUrl = await p.instance.getDataURL({
        type: 'png',
        pixelRatio: PIXEL_RATIO,
        backgroundColor,
      });
    } catch {
      continue;
    }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:') || !dataUrl.includes(','))
      continue;
    out.push({ id: p.id, title: p.title, dataUrl });
  }
  return out;
}

export function capturedToFile(captured: CapturedPlot, index: number): File {
  const safe = captured.title.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const name = `trace_plot_${index + 1}_${safe || captured.id}.png`;
  return new File([dataUrlToBlob(captured.dataUrl)], name, { type: 'image/png' });
}

// Stack captured plots vertically onto one canvas for the "combined image"
// option. Returns a single PNG File. Resolves once every source image loads.
export async function composePlots(
  captured: CapturedPlot[],
  backgroundColor: string
): Promise<File> {
  if (captured.length === 0) throw new Error('No plots to compose');

  const images = await Promise.all(
    captured.map(
      (c) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error(`Failed to load plot image ${c.id}`));
          img.src = c.dataUrl;
        })
    )
  );

  const width = Math.max(...images.map((i) => i.width));
  const height = images.reduce((sum, i) => sum + i.height, 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.height;
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Failed to encode combined image');
  return new File([blob], 'trace_plots_combined.png', { type: 'image/png' });
}
