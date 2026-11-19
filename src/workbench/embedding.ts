// The embedding signals a tool page reads from its own URL; the host that
// embeds the page in an iframe sets them.
//
// - `embedded=true`: the page runs inside a host. The theme follows the host,
//   and primary+K asks the host for its quick-open palette.
// - `hostbar=1` (with `embedded=true`): the host draws the tool's tile bar and
//   its verbs. The actions bar is hidden but its shortcuts still bind,
//   primary+S asks the host to save its view, the tool reports its actions
//   (`canopy:tool-actions`) and runs the ones the host invokes back
//   (`canopy:tool-invoke`), and the frame draws no verbs of its own.
//
// The messages are documented in docs/workbench.md. The iframe src is fixed
// when the host mounts the page, so the callers read these once per mount.

/** The page runs inside a host (`embedded=true`). Pure on `search`. */
export function embeddedPage(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('embedded') === 'true';
}

/** The host draws the tool's tile bar and its verbs (`embedded=true` and `hostbar=1`). Pure on `search`. */
export function hostBarPage(search: string = window.location.search): boolean {
  return embeddedPage(search) && new URLSearchParams(search).get('hostbar') === '1';
}
