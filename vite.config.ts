import { defineConfig } from 'vitest/config';
import { loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { canopyDevProxy, type CanopyDevProxyOptions } from '@slaclab/canopy-vite';

// The Canopy modules Trace calls, as same-origin per-module paths.
export const CANOPY_MODULES = ['/mole', '/hare', '/fox', '/magpie', '/vole'];

// Trace's app in Canopy's e-log module: the only e-log path the dev proxy
// forwards. Canopy doesn't bind keys to apps ({app} only picks the server-side
// elog-plus token), so a key with e-log write sent on a wider prefix could post
// as any app configured in Canopy.
export const ELOG_APP_PATH = '/elog/v1/apps/trace';

// VITE_CANOPY_BASE_PATH as the bundle reads it (src/api/connection.ts): trimmed,
// without trailing slashes. '' (unset, empty or '/') means the per-module paths.
// Kept here rather than imported: connection.ts reads import.meta.env, which
// vite.config.ts can't.
export function normalizeBasePath(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

// Dev-server proxy options for the Canopy modules. The key stays server-side
// (no VITE_ prefix): the proxy injects X-API-Key on requests and WebSocket
// upgrades, so the browser bundle never holds it. In prod a reverse proxy owns
// the same paths and headers.
//
// The proxy serves the layout the bundle uses (src/api/connection.ts):
// - VITE_CANOPY_BASE_PATH unset: the per-module paths in CANOPY_MODULES,
//   forwarded unchanged.
// - VITE_CANOPY_BASE_PATH set (the deployed layout, e.g. /trace/api/canopy):
//   that one prefix, stripped before forwarding, like the container's nginx.
export function canopyProxyOptions(env: Record<string, string>): CanopyDevProxyOptions {
  const basePath = normalizeBasePath(env.VITE_CANOPY_BASE_PATH);
  return {
    target: env.CANOPY_BASE_URL,
    apiKey: env.CANOPY_API_KEY,
    // canopy-vite would otherwise put CANOPY_ELOG_API_KEY on all of
    // ${basePath}/elog when it is set in the environment; the e-log key is
    // scoped to ELOG_APP_PATH by elogProxy() instead.
    elogApiKey: '',
    ...(basePath ? { basePath } : { modules: CANOPY_MODULES }),
  };
}

// The e-log route: ELOG_APP_PATH (under VITE_CANOPY_BASE_PATH when set) with
// CANOPY_ELOG_API_KEY, or CANOPY_API_KEY when that is unset. Built by
// canopyDevProxy, so it refuses cross-origin requests and drops cookies like
// the Canopy routes. On top of that the key is only sent when the path, with
// `..` and %2e%2e resolved as Canopy will, is still under ELOG_APP_PATH: Vite
// matches the prefix against the raw URL, so /elog/v1/apps/trace/../other
// would match too. The forwarded path starts with the target's own path when
// CANOPY_BASE_URL has one (Canopy mounted under a prefix), so the check allows
// for it.
export function elogProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const basePath = normalizeBasePath(env.VITE_CANOPY_BASE_PATH);
  const routes = canopyDevProxy({
    target: env.CANOPY_BASE_URL,
    apiKey: env.CANOPY_ELOG_API_KEY || env.CANOPY_API_KEY,
    modules: [`${basePath}${ELOG_APP_PATH}`],
  });
  return Object.fromEntries(
    Object.entries(routes).map(([key, route]) => {
      const appPath = `${targetPath(route.target)}${ELOG_APP_PATH}`;
      return [
        key,
        {
          ...route,
          // E-log is REST only.
          ws: false,
          ...(basePath ? { rewrite: (path: string) => path.slice(basePath.length) } : {}),
          configure: (proxy, options) => {
            route.configure?.(proxy, options);
            proxy.on('proxyReq', (proxyReq) => {
              const path = new URL(proxyReq.path, 'http://localhost').pathname;
              if (path !== appPath && !path.startsWith(`${appPath}/`)) {
                proxyReq.removeHeader('X-API-Key');
              }
            });
          },
        } satisfies ProxyOptions,
      ];
    })
  );
}

// The path part of a proxy target URL, without a trailing slash: '' for
// http://host:8000, '/canopy' for http://host/canopy/.
function targetPath(target: ProxyOptions['target']): string {
  if (typeof target !== 'string') return '';
  try {
    return new URL(target).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
    server: {
      // The e-log route first: Vite uses the first matching key, and under
      // VITE_CANOPY_BASE_PATH the Canopy route's prefix covers it too.
      proxy: { ...elogProxy(env), ...canopyDevProxy(canopyProxyOptions(env)) },
    },
    test: {
      passWithNoTests: true,
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
