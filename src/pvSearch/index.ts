// PV-name suggestions for every PV field: Trace's PV Name, the
// add-trace row and the Correlation and Waveform sections. Two sources,
// merged: the host's channel catalog ranked in the browser (catalog.ts,
// fuzzy.ts), then Mole's archiver index (mole.ts), debounced per field by
// usePVSearch.

export {
  CHANNEL_DEBOUNCE_MS,
  channelMatches,
  loadChannelCatalog,
  mergeSuggestions,
  pvNameSuggestions,
  resetChannelCatalog,
  useChannelCatalog,
  useChannelMatches,
} from './catalog';
export {
  MIN_POOL,
  RENDER_CAP,
  fuzzyMatch,
  matchChannels,
  type ChannelMatch,
  type ChannelMatchResult,
  type FuzzyResult,
} from './fuzzy';
export { MOLE_SEARCH_LIMIT, moleSearch, moleSearchPattern, type PvSearch } from './mole';
export { usePVSearch, type PVSearchResult, type PVSearchStatus } from './usePVSearch';
