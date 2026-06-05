// Tiny helper: trigger a browser download for an in-memory string blob.
export function downloadBlob(filename: string, mime: string, body: BlobPart): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on next tick — some browsers need the URL alive until the click
  // navigation actually happens.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    // Some browsers cancel without firing change; resolve null on body focus
    // returning to give the picker a chance to clean itself up.
    document.body.appendChild(input);
    input.click();
  });
}
