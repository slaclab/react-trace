// The menus' way out of the tool: the clipboard.
//
// The async Clipboard API, and for text a hidden-textarea
// `execCommand('copy')` fallback where the API is refused (an iframe without
// clipboard-write, an insecure origin). Each resolves to true once copied.

function copyByCommand(text: string, doc: Document): boolean {
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  const focused = doc.activeElement as HTMLElement | null;
  area.select();
  let ok: boolean;
  try {
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  focused?.focus?.({ preventScroll: true });
  return ok;
}

/** Put `text` on the clipboard. */
export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  const clip = doc.defaultView?.navigator.clipboard;
  if (clip?.writeText) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // Refused (permissions policy, no focus): fall back below.
    }
  }
  return copyByCommand(text, doc);
}

/**
 * Put a PNG on the clipboard; false where images cannot be copied. The item
 * is handed the pending blob, so the copy keeps the click's user activation
 * while the image is drawn.
 */
export async function copyPng(
  blob: Promise<Blob | null>,
  doc: Document = document
): Promise<boolean> {
  const win = doc.defaultView;
  const clip = win?.navigator.clipboard;
  const Item = (win as (Window & { ClipboardItem?: typeof ClipboardItem }) | null)?.ClipboardItem;
  if (!clip?.write || !Item) return false;
  const png = blob.then((b) => {
    if (b === null) throw new Error('The plot could not be drawn');
    return b;
  });
  try {
    await clip.write([new Item({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}
