import { CliStructuredError } from '@internal/foundation/errors';
import { UsageError } from 'clipanion';
import { run } from './main.ts';
import { renderErrorEnvelope } from './render-error.ts';

/** Printed for a non-structured escape — by the shared base-type rules that is a bug, not a user failure. */
const REPORT_HINT =
  'This is a bug in prisma-composer, not in your app — please report it: ' +
  'https://github.com/prisma/composer/issues';

/**
 * Run the `prisma-composer` CLI end to end: dispatch `argv`, map errors to exit
 * codes — usage errors and structured failures exit 2 (expected failures),
 * anything else is a bug and exits 1 with a report hint. Shared by this
 * package's `bin` and the unscoped `prisma-composer` launcher.
 */
export async function cli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (CliStructuredError.is(error)) {
      console.error(renderErrorEnvelope(error.toEnvelope()));
      process.exitCode = 2;
      return;
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(REPORT_HINT);
    process.exitCode = 1;
  }
}
