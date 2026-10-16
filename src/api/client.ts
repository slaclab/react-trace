// Kept only for the e-log client (api/elog.ts and its tests), which moves to
// its own @slaclab/canopy-elog package under a separate ticket. Everything
// else imports CanopyError from @slaclab/canopy-client directly.
export { CanopyError } from '@slaclab/canopy-client';
