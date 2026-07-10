/**
 * Barrel for tests and any programmatic use; `bin.ts` is the CLI entrypoint.
 */
export { cli } from './cli.ts';
export { CliError } from './cli-error.ts';
export { renderStackFile, writeStackFile } from './generate-stack.ts';
export { inferTarget } from './infer-target.ts';
export { loadEntry } from './load-entry.ts';
export type { RunDeps } from './main.ts';
export { run } from './main.ts';
export { resolveAlchemyBin, runAlchemy } from './run-alchemy.ts';
