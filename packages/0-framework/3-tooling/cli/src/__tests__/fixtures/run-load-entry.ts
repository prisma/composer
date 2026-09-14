/**
 * A minimal driver for `loadEntry` alone, spawned under real node (see
 * `jsx-load-error.test.ts`) — the full CLI (`bin.ts`) also requires a
 * discovered `prisma-composer.config.ts`, which this fixture doesn't need
 * to prove. Prints the structured error's summary/why/fix/where the way the
 * CLI's renderer would, so the spawn-based tests can pin the full guidance.
 */
import { CliStructuredError } from '@internal/foundation/errors';
import { loadEntry } from '../../load-entry.ts';

const entryArg = process.argv[2];
if (entryArg === undefined) throw new Error('usage: run-load-entry.ts <entry>');

loadEntry(entryArg, process.cwd())
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    if (CliStructuredError.is(error)) {
      console.error(error.message);
      if (error.why !== undefined) console.error(error.why);
      if (error.fix !== undefined) console.error(error.fix);
      if (error.where?.path !== undefined) console.error(`Where: ${error.where.path}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
