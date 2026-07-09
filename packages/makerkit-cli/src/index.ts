/**
 * Barrel for tests and any programmatic use; `bin.ts` is the CLI entrypoint.
 */
export { assembleServices } from './assemble-services.ts';
export { CliError } from './cli-error.ts';
export { renderStackFile, writeStackFile } from './generate-stack.ts';
export { inferTarget } from './infer-target.ts';
export { loadEntry } from './load-entry.ts';
export { parseArgs, run, USAGE, UsageError } from './main.ts';
export { resolveAlchemyBin, runAlchemy } from './run-alchemy.ts';
