// The app's links, as the build sets them: a deployment points the bug-report
// and docs links at its own feedback form and docs site with the build-time
// variables VITE_BUG_REPORT_URL and VITE_DOCS_URL; unset, they are this
// repository's issues and public docs. They are the built-in values of the
// site's `header.bugReportUrl` and `header.docsUrl` (src/site), which a
// `config.json` or Canopy's site settings can override without a rebuild.

export const BUG_REPORT_URL =
  (import.meta.env.VITE_BUG_REPORT_URL as string | undefined) ||
  'https://github.com/slaclab/react-trace/issues/new/choose';
export const DOCS_URL =
  (import.meta.env.VITE_DOCS_URL as string | undefined) || 'https://slaclab.github.io/react-trace/';
