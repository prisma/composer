import { UsageError } from 'clipanion';
import { run } from './main.ts';

/**
 * Run the `prisma-app` CLI end to end: dispatch `argv`, map errors to exit
 * codes. Shared by this package's `bin` and the unscoped `prisma-app` launcher.
 */
export async function cli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
