/**
 * Barrel for tests and any programmatic use; `bin.ts` is the CLI entrypoint.
 */
export { CliStructuredError } from '@internal/foundation/errors';
export { cli, shippedVersion } from '../cli.ts';
export { renderStackFile, writeStackFile } from '../generate-stack.ts';
export { loadEntry } from '../load-entry.ts';
export { alchemyInvocation, resolveAlchemyBin, spawnAlchemy } from '../run-alchemy.ts';
