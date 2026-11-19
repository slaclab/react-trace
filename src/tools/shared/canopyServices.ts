// The SDK services a context tool (Correlation, Waveform) runs on its own
// page: Hare's PV stream and the Formula Engine's formula stream, reached
// through the app's Canopy connection (src/api/connection.ts), the way
// liveStore reaches Hare. The sockets are same-origin under the connection's
// base; the proxy in front injects the key.
import {
  toWsUrl,
  type CanopyConnection,
  type FormulaEngineServiceOptions,
  type HarePVServiceOptions,
} from '@slaclab/canopy-client';
import { canopyConnection } from '../../api/connection';

const HARE_WS_PATH = '/hare/v1/ws/pvs';
const FORMULA_ENGINE_WS_PATH = '/formula-engine/v1/ws/formulas';

// The tools' services keep reconnecting after any close. The SDK stops a
// socket for good after a 1008 close ("invalid API key") until connect() is
// called again, but the key is the proxy's, so a 1008 clears without a reload
// once the proxy is fixed, and a tool page connects once at mount: nothing
// would reconnect it.
const ALWAYS_RECONNECT = { terminalCloseCodes: [] as number[] };

/** Options of a tool page's SDK `HarePVService`. */
export function hareServiceOptions(
  conn: CanopyConnection = canopyConnection
): HarePVServiceOptions {
  return {
    url: toWsUrl(conn.baseUrl, HARE_WS_PATH),
    apiKey: conn.apiKey,
    fetchFn: conn.fetch,
    ...ALWAYS_RECONNECT,
  };
}

/**
 * Options of a tool page's SDK `FormulaEngineService`. The WS URL is
 * explicit, from the same base as every other request.
 */
export function formulaEngineServiceOptions(
  conn: CanopyConnection = canopyConnection
): FormulaEngineServiceOptions {
  return {
    baseUrl: conn.baseUrl,
    wsUrl: toWsUrl(conn.baseUrl, FORMULA_ENGINE_WS_PATH),
    apiKey: conn.apiKey,
    ...ALWAYS_RECONNECT,
  };
}
