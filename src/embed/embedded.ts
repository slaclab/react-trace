// `?embedded=true` marks the app as hosted inside another page (a Canopy
// workspace). The host then owns the theme (state/colorMode.ts) and talks to
// Trace through the message bridge (embed/bridge.ts).
export function isEmbedded(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('embedded') === 'true';
}
