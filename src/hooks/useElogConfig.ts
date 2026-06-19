import { useState, useEffect } from 'react';

import { listLogbooks, type ElogLogbook } from '../api/elog';

export interface ElogConfig {
  enabled: boolean;
  logbooks: ElogLogbook[];
  defaultLogbooks: string[];
}

const DISABLED: ElogConfig = { enabled: false, logbooks: [], defaultLogbooks: [] };

function parseDefaults(): string[] {
  const raw = import.meta.env.VITE_ELOG_DEFAULT_LOGBOOKS as string | undefined;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// No config endpoint exists on elog-plus, so availability is inferred: if the
// logbooks list loads, the feature is on. Cached at module scope so the dialog
// and the toolbar button share one fetch. On failure we reset the cache so a
// later open can retry, and report disabled so the button stays hidden.
let cache: Promise<ElogConfig> | null = null;

function fetchConfig(): Promise<ElogConfig> {
  if (!cache) {
    cache = listLogbooks()
      .then((logbooks) => ({
        enabled: true,
        logbooks,
        defaultLogbooks: parseDefaults(),
      }))
      .catch(() => {
        cache = null;
        return DISABLED;
      });
  }
  return cache;
}

export function useElogConfig(): ElogConfig | null {
  const [config, setConfig] = useState<ElogConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
