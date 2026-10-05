/**
 * Public surface (the `./family` subpath): composer's `CommandFamily`.
 *
 * This entrypoint's static graph must stay free of alchemy and of effect value
 * imports — the `prisma` bin imports it directly, so everything reachable from
 * here loads on `prisma --version`. See ../family/family.ts for the mechanism
 * that holds, and scripts/check-family-static-graph.mjs for the check that
 * proves it against built output.
 */

export type { ComposerOperations, CreateComposerFamilyOptions } from '../family/family.ts';
export { createComposerFamily, realOperations } from '../family/family.ts';
export { composerSection } from '../family/section.ts';
export { toEngineError } from '../family/translate-error.ts';
