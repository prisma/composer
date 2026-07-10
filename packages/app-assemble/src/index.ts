/**
 * Barrel for @prisma/app-assemble's consumers — @prisma/app-cli today, the future
 * programmatic deploy API second. Public surface: assembleServices() (the
 * orchestration) and AssembleError (this package's own typed failure — no CLI
 * concepts leak through it). `RunAssembler` is the seam a caller substitutes
 * in tests to avoid a real build; each service node loads and calls its own
 * build adapter (node-owned loading — see @prisma/app's node.ts), so this
 * package no longer resolves or imports anything on a node's behalf.
 */

export { AssembleError } from './assemble-error.ts';
export type { AssembledServices, RunAssembler } from './assemble-services.ts';
export { assembleServices } from './assemble-services.ts';
