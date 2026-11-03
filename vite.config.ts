import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import {
  canopyDevProxy,
  DEFAULT_CANOPY_TARGET,
  type CanopyDevProxyOptions,
} from '@slaclab/canopy-vite';
import { assertSinglePackageDirs } from './vite.dupGuard.ts';

// Fail the build when react, react-dom or @carbon/react is bundled from more
// than one directory: the resolve block below is what keeps them single, and a
// second copy breaks hooks and context only at runtime.
function dupGuard(): Plugin {
  return {
    name: 'trace-dup-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((file) =>
        file.type === 'chunk' ? file.moduleIds : []
      );
      assertSinglePackageDirs(ids, realpathSync);
    },
  };
}

// Dev-server proxy options for Canopy. The key stays server-side (no VITE_
// prefix): the proxy injects X-API-Key on Canopy requests and WebSocket
// upgrades, so the browser bundle never holds it. In prod a reverse proxy owns
// the same paths and headers.
//
// The proxy serves the layout the bundle uses (src/api/connection.ts):
// - VITE_CANOPY_BASE_PATH unset: per-module paths /mole, /hare and /formula-engine,
//   forwarded unchanged.
// - VITE_CANOPY_BASE_PATH set (the deployed layout, e.g. /trace/api/canopy):
//   that one prefix, stripped before forwarding, like the container's nginx.
export function canopyProxyOptions(env: Record<string, string>): CanopyDevProxyOptions {
  const basePath = env.VITE_CANOPY_BASE_PATH?.trim();
  return {
    target: env.CANOPY_BASE_URL,
    apiKey: env.CANOPY_API_KEY,
    ...(basePath ? { basePath } : { modules: ['/mole', '/hare', '/formula-engine'] }),
  };
}

// Trace's app in Canopy's e-log module, the only e-log path the proxy forwards.
export const ELOG_APP_PATH = '/elog/v1/apps/trace/';

// E-log has its own key (read+write@elog) so CANOPY_API_KEY can stay read-only:
// Canopy's write scope is per key, so one key with write would also allow PV
// writes through Hare. Local dev keys are usually @*, so fall back to
// CANOPY_API_KEY when CANOPY_ELOG_API_KEY is unset. The route is scoped to
// Trace's own app: Canopy doesn't bind keys to apps ({app} only picks the
// server-side elog-plus token), so a wider prefix would let the key post as any
// configured app. It is listed before the Canopy routes, so it wins under a
// VITE_CANOPY_BASE_PATH prefix too.
export function elogAppProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const basePath = (env.VITE_CANOPY_BASE_PATH ?? '').trim().replace(/\/+$/, '');
  const target = env.CANOPY_BASE_URL || DEFAULT_CANOPY_TARGET;
  const elogApiKey = env.CANOPY_ELOG_API_KEY || env.CANOPY_API_KEY || '';
  return {
    [`${basePath}${ELOG_APP_PATH}`]: {
      target,
      changeOrigin: true,
      ...(basePath ? { rewrite: (path: string) => path.slice(basePath.length) } : {}),
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          // Vite matches the prefix against the raw URL, so
          // /elog/v1/apps/trace/../other/ gets here too. Check the path with
          // `..` (and %2e%2e) resolved, as it reaches Canopy.
          const path = new URL(proxyReq.path, 'http://localhost').pathname;
          if (elogApiKey && path.startsWith(ELOG_APP_PATH)) {
            proxyReq.setHeader('X-API-Key', elogApiKey);
          }
        });
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react(), dupGuard()],
    // Force react and @carbon/react to this app's single copy; the @slaclab SDK
    // packages otherwise pull their own, bundling a second React/Carbon.
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@carbon/react': fileURLToPath(new URL('./node_modules/@carbon/react', import.meta.url)),
      },
    },
    server: {
      proxy: { ...elogAppProxy(env), ...canopyDevProxy(canopyProxyOptions(env)) },
    },
    test: {
      passWithNoTests: true,
    },
  };
});
