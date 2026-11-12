// The query keys that configure a tool page rather than its content: the
// colour theme, `embedded=true` and the host-bar flag `hostbar=1`
// (`workbench/embedding.ts`). The opening query is read without them, and a
// state write keeps them in front of the new query.

export const PAGE_KEYS: readonly string[] = ['theme', 'embedded', 'hostbar'];
