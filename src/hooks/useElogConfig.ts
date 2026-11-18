import { useState, useEffect } from 'react';

import { describeElogError, getElogConfig } from '../api/elog';

export interface ElogConfig {
  enabled: boolean;
  defaultLogbookIds: string[];
}

const DISABLED: ElogConfig = { enabled: false, defaultLogbookIds: [] };

// Canopy's e-log /config says whether posting is available for Trace (a provider
// is configured and Trace has a token there). Cached at module scope so the
// dialog and the toolbar button share one fetch. A disabled config is cached as
// is; a failed fetch resets the cache so a later mount can retry. Either way the
// button stays hidden, so log why instead of disappearing silently.
let cache: Promise<ElogConfig> | null = null;

export function loadElogConfig(): Promise<ElogConfig> {
  if (!cache) {
    cache = getElogConfig()
      .then((config): ElogConfig => {
        if (!config.enabled) {
          console.info(`E-log posting disabled: ${config.reason ?? 'no reason given'}`);
          return DISABLED;
        }
        return { enabled: true, defaultLogbookIds: config.defaultLogbookIds ?? [] };
      })
      .catch((err: unknown) => {
        cache = null;
        console.warn(`E-log posting unavailable: ${describeElogError(err)}`);
        return DISABLED;
      });
  }
  return cache;
}

export function useElogConfig(): ElogConfig | null {
  const [config, setConfig] = useState<ElogConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadElogConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
