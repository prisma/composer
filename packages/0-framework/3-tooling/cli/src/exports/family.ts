/**
 * Public surface (the `./family` subpath): composer's `CommandFamily` and the
 * thin CLI that mounts it.
 *
 * This entrypoint's static graph must stay free of alchemy and of effect value
 * imports — the `prisma` bin imports it directly, so everything reachable from
 * here loads on `prisma --version`. See ../family/family.ts for the mechanism
 * that holds, and scripts/check-family-static-graph.mjs for the check that
 * proves it against built output.
 */

export type { ComposerCliSpec } from '../family/engine-cli.ts';
export { BINARY_NAME, createComposerCli, runComposerCli } from '../family/engine-cli.ts';
export type { ComposerOperations, CreateComposerFamilyOptions } from '../family/family.ts';
export { createComposerFamily, realOperations } from '../family/family.ts';
export type { ComposerSection } from '../family/section.ts';
export { composerSection } from '../family/section.ts';
export { toEngineError } from '../family/translate-error.ts';
