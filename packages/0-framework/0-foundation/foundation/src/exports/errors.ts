/** Public surface: the shared CLI error foundation (duplicated from prisma/prisma pending extraction). Implementation lives in `../structured-error.ts`, `../internal-error.ts`, and `../cli-structured-error.ts`. */
export type {
  CliErrorConflict,
  CliErrorEnvelope,
} from '../cli-structured-error.ts';
export { CliStructuredError } from '../cli-structured-error.ts';
export { assertNever, InternalError, isInternalError } from '../internal-error.ts';
export type { StructuredError, StructuredErrorOptions } from '../structured-error.ts';
export {
  DOCS_BASE,
  docsUrlFor,
  isStructuredError,
  structuredError,
} from '../structured-error.ts';
