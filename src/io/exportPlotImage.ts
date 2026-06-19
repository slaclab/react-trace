// Capture ECharts plots as PNG blobs for e-log attachments. We only need the
// `getDataURL` slice of the ECharts instance, so we type against that to avoid
// pulling the full echarts type surface through every caller.
export interface PngSource {
  getDataURL(opts?: {
    type?: 'png' | 'jpeg' | 'svg';
    pixelRatio?: number;
    backgroundColor?: string;
  }): string;
}

export interface CapturedPlot {
  id: string;
  title: string;
  dataUrl: string;
}

const PIXEL_RATIO = 2;

function plotDataUrl(instance: PngSource, backgroundColor: string): string {
  return instance.getDataURL({ type: 'png', pixelRatio: PIXEL_RATIO, backgroundColor });
}

// data: URL -> Blob without a network round-trip via fetch (keeps it sync-ish
// and avoids CSP surprises). The data URL is always base64 PNG here.
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = header.slice(header.indexOf(':') + 1, header.indexOf(';')) || 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Capture each plot as its own PNG data URL. Skips plots that fail to render
// (e.g. detached/unmounted) rather than aborting the whole batch.
export function capturePlots(
  plots: { id: string; title: string; instance: PngSource | null | undefined }[],
  backgroundColor: string
): CapturedPlot[] {
  const out: CapturedPlot[] = [];
  for (const p of plots) {
    if (!p.instance) continue;
    out.push({ id: p.id, title: p.title, dataUrl: plotDataUrl(p.instance, backgroundColor) });
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
