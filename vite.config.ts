import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { canopyDevProxy, type CanopyDevProxyOptions } from '@slaclab/canopy-vite';

// Dev-server proxy options for Canopy and e-log. The keys stay server-side
// (no VITE_ prefix): the proxy injects X-API-Key on Canopy requests and
// WebSocket upgrades, and the e-log access token on /elog, so the browser bundle
// never holds either. In prod a reverse proxy owns the same paths and headers.
//
// The proxy serves the layout the bundle uses (src/api/connection.ts):
// - VITE_CANOPY_BASE_PATH unset: per-module paths /mole, /hare and /fox,
//   forwarded unchanged.
// - VITE_CANOPY_BASE_PATH set (the deployed layout, e.g. /trace/api/canopy):
//   that one prefix, stripped before forwarding, like the container's nginx.
export function canopyProxyOptions(env: Record<string, string>): CanopyDevProxyOptions {
  const basePath = env.VITE_CANOPY_BASE_PATH?.trim();
  return {
    target: env.CANOPY_BASE_URL,
    apiKey: env.CANOPY_API_KEY,
    ...(basePath ? { basePath } : { modules: ['/mole', '/hare', '/fox'] }),
    // Left out when ELOG_BASE_URL is unset, which hides e-log posting. An
    // empty ELOG_TOKEN_HEADER keeps the SDK's x-vouch-idp-accesstoken.
    elog: {
      target: env.ELOG_BASE_URL,
      accessToken: env.ELOG_API_KEY,
      accessTokenHeader: env.ELOG_TOKEN_HEADER,
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
    server: {
      proxy: canopyDevProxy(canopyProxyOptions(env)),
    },
    test: {
      passWithNoTests: true,
    },
  };
});
