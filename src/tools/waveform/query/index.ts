// The Waveform link format; the grammar is documented in docs/waveform.md (Link format).
//
// The only parser of the link and owner of the state's shape and defaults.

export * from './state';
export { normalizeDrawings, normalizeWaveformState, sameWaveformState } from './normalize';
export { parseWaveformQuery } from './parse';
export { serializeWaveformQuery, serializeWaveformQueryWithShed } from './serialize';
