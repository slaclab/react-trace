import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.CANOPY_BASE_URL ?? 'http://localhost:8000';
  const apiKey = env.CANOPY_API_KEY ?? '';

  return {
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
      },
    },
    test: {
      passWithNoTests: true,
    },
  };
});
