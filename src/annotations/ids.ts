// Drawing ids: `annotation-<ms>-<n>`, the shape `src/id.ts` `makeId`
// gives every other entity, generated here so the drawing core imports
// nothing outside its boundary. Drawing ids come only from this module, so
// its own monotonic counter keeps them unique within one millisecond exactly
// as the shared per-kind counter did.
let counter = 0;

/** A new, session-unique drawing id. */
export function makeAnnotationId(): string {
  counter += 1;
  return `annotation-${Date.now()}-${counter}`;
}
