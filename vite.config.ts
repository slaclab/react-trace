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
  // E-log (elog-plus) is a separate microservice; the dev proxy injects its
  // access token so the key never reaches the browser bundle. In prod a reverse
  // proxy owns the same /elog -> elog-plus rewrite + header injection.
  const elogTarget = env.ELOG_BASE_URL ?? '';
  const elogKey = env.ELOG_API_KEY ?? '';

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
        // Fox (formula evaluation): REST validate/evaluate plus the live-formula
        // WebSocket. `ws: true` upgrades /fox/v1/ws/formulas; X-API-Key is injected
        // on both the HTTP and WS paths so the bundle never holds the key.
        '/fox': {
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
        ...(elogTarget
          ? {
              '/elog': {
                target: elogTarget,
                changeOrigin: true,
                rewrite: (path: string) => path.replace(/^\/elog/, ''),
                configure: (proxy) => {
                  proxy.on('proxyReq', (proxyReq) => {
                    if (elogKey) proxyReq.setHeader('x-vouch-idp-accesstoken', elogKey);
                  });
                },
              },
            }
          : {}),
      },
    },
    test: {
      passWithNoTests: true,
    },
  };
});
