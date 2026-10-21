import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.CANOPY_BASE_URL ?? 'http://localhost:8000';
  const apiKey = env.CANOPY_API_KEY ?? '';

  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
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
        // E-log: Canopy's shared e-log module, which holds Trace's elog-plus
        // application token server-side. Same X-API-Key injection as above; the
        // key needs the `elog` module scope.
        '/elog': {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-API-Key', apiKey);
            });
          },
        },
      },
    },
    test: {
      passWithNoTests: true,
    },
  };
});
