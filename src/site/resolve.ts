// The resolved site defaults: the built-ins, then each source in order, later
// winning key by key. Within one source the shared `plot` section applies to
// every tool first and a tool's own `<tool>.plot` after it, so a file's
// shared `plot.tooltip` overrides a tool's built-in read-out and a later
// source's shared key overrides an earlier source's per-tool one.
import { BUILTIN_DEFAULTS, deepFreeze } from './builtins';
import type { SiteConfig, SiteDefaults } from './types';

/** The defaults `sources` resolve to over `base` (the built-ins); frozen. */
export function resolveSiteDefaults(
  sources: readonly SiteConfig[],
  base: SiteDefaults = BUILTIN_DEFAULTS
): SiteDefaults {
  const out: SiteDefaults = {
    header: { ...base.header },
    trace: { plot: { ...base.trace.plot }, trace: { ...base.trace.trace } },
    correlation: { ...base.correlation, plot: { ...base.correlation.plot } },
    waveform: { ...base.waveform, plot: { ...base.waveform.plot } },
  };
  for (const source of sources) {
    out.header = { ...out.header, ...source.header };
    out.trace.plot = { ...out.trace.plot, ...source.plot, ...source.trace?.plot };
    out.trace.trace = { ...out.trace.trace, ...source.trace?.trace };
    const { plot: _correlationPlot, ...correlation } = source.correlation ?? {};
    const { plot: _waveformPlot, ...waveform } = source.waveform ?? {};
    void _correlationPlot;
    void _waveformPlot;
    out.correlation = {
      ...out.correlation,
      ...correlation,
      plot: { ...out.correlation.plot, ...source.plot, ...source.correlation?.plot },
    };
    out.waveform = {
      ...out.waveform,
      ...waveform,
      plot: { ...out.waveform.plot, ...source.plot, ...source.waveform?.plot },
    };
  }
  return deepFreeze(out);
}
