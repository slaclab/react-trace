import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.CANOPY_BASE_URL ?? 'http://localhost:8000';
  const apiKey = env.CANOPY_API_KEY ?? '';
  // E-log has its own key (read+write@elog), sent only on Trace's e-log app path,
  // so CANOPY_API_KEY needs no e-log scope (see the proxy entry below). Local dev
  // keys are usually @*, so fall back to CANOPY_API_KEY when CANOPY_ELOG_API_KEY
  // is unset.
  const elogApiKey = env.CANOPY_ELOG_API_KEY || apiKey;
  // Trace's app in Canopy's e-log module, the only e-log path the proxy forwards.
  const elogAppPath = '/elog/v1/apps/trace/';

  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react(), dupGuard()],
    // Force react and @carbon/react to this app's single copy; a dependency
    // that brings its own (the @slaclab SDK packages do) would otherwise bundle
    // a second React/Carbon.
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@carbon/react': fileURLToPath(new URL('./node_modules/@carbon/react', import.meta.url)),
      },
    },
    server: {
      proxy: {
        '/mole': {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
          },
        },
        // Magpie (config store): REST CRUD for saving/sharing workspaces. Same
        // X-API-Key injection as /mole so the bundle never holds the key.
        '/magpie': {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
          },
        },
        // Hare lives behind the same backend host. WebSocket upgrades for the
        // live-PV stream go through this proxy with `ws: true`. The same
        // X-API-Key injection covers both the HTTP and the WS upgrade path so
        // the bundle never holds the key.
        '/hare': {
          target,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
            proxy.on('proxyReqWs', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
          },
        },
        // Formula Engine (formula evaluation): REST validate/evaluate plus the live-formula
        // WebSocket. `ws: true` upgrades /formula-engine/v1/ws/formulas; X-API-Key is injected
        // on both the HTTP and WS paths so the bundle never holds the key.
        '/formula-engine': {
          target,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
            proxy.on('proxyReqWs', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
          },
        },
        '/vole': {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
          },
        },
        // E-log: Canopy's shared e-log module, which holds Trace's elog-plus
        // application token server-side. Injects the dedicated e-log key, scoped
        // to Trace's own app: Canopy doesn't bind keys to apps ({app} only picks
        // the server-side elog-plus token), so a wider prefix would let the key
        // post as any configured app. Other /elog paths aren't proxied.
        [elogAppPath]: {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              // Vite matches the prefix against the raw URL, so
              // /elog/v1/apps/trace/../other/ gets here too. Check the path with
              // `..` (and %2e%2e) resolved, as it reaches Canopy.
              const path = new URL(proxyReq.path, 'http://localhost').pathname;
              if (elogApiKey && path.startsWith(elogAppPath)) {
                proxyReq.setHeader('X-API-Key', elogApiKey);
              }
            });
          },
        },
      },
    },
    test: {
      passWithNoTests: true,
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
