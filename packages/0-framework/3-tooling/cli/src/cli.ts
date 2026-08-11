/**
 * The `prisma-composer` entrypoint: adapt this process into the engine's
 * `HostProcess`, run one invocation of composer's own CLI, and hand back an
 * exit code. Grammar, help, argument validation, output framing, exit codes
 * and signal policy all belong to the engine — this module contributes the
 * process and the version, and nothing else.
 *
 * Node's `process` already satisfies `HostProcess` structurally, so there is
 * no adapter object here; that is the whole point of the engine taking a host
 * surface rather than reading globals.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runComposerCli } from './family/engine-cli.ts';

/** Printed for a throw that escapes the engine entirely — by the shared base-type rules that is a bug, not a user failure. */
const REPORT_HINT =
  'This is a bug in prisma-composer, not in your app — please report it: ' +
  'https://github.com/prisma/composer/issues';

const UNKNOWN_VERSION = 'unknown';

/**
 * The version the CLI reports, read from the manifest of the package this
 * module was BUNDLED INTO — `@prisma/composer` for the published bin, since
 * that is the package whose executable the user installed. Walking up from the
 * module's own location is what makes that true in both layouts: the published
 * `dist/bin.mjs` finds `@prisma/composer`'s manifest, and a direct run of
 * `src/bin.ts` finds this package's.
 */
export function shippedVersion(
  fromDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = fromDir;
  while (true) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const version: unknown = JSON.parse(fs.readFileSync(manifest, 'utf-8')).version;
      return typeof version === 'string' ? version : UNKNOWN_VERSION;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return UNKNOWN_VERSION;
    dir = parent;
  }
}

/**
 * Runs `prisma-composer` end to end and returns the process exit code. The
 * caller assigns it to `process.exitCode` rather than exiting, so the streams
 * drain — the engine returns a code for exactly this reason.
 *
 * The catch is not error handling for commands: the engine renders every
 * command failure itself. It catches a throw that escaped the engine — a
 * construction fault, a broken config load — which by ADR-0044 is a bug in
 * this CLI and exits 1 with a report hint.
 */
export async function cli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await runComposerCli(argv, process, { version: shippedVersion() });
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(REPORT_HINT);
    return 1;
  }
}
