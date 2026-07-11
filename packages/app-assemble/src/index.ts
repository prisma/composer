/**
 * Barrel for @prisma/app-assemble's consumers — @prisma/app-cli today, the future
 * programmatic deploy API second. Public surface: assembleServices() (the
 * orchestration) and AssembleError (this package's own typed failure — no CLI
 * concepts leak through it). `RunAssembler` is the seam a caller substitutes
 * in tests to avoid a real build; the default routes each service's build
 * through the config's extension registries (ADR-0017), so this package
 * never resolves or imports a module on a node's behalf.
 */

export { AssembleError } from './assemble-error.ts';
export type { AssembledServices, RunAssembler } from './assemble-services.ts';
export { assembleServices } from './assemble-services.ts';
