/**
 * Local-dev spec § 6 `run-dev.ts`: `prisma-composer dev <entry>` — the CLI
 * adapter over the programmatic `dev()` operation
 * (../operations/execute-dev.ts): parse-shaped args in, events rendered to the
 * console, signal handling and exit codes owned here. The pipeline itself
 * (capability check, containers, `--fresh` teardown, preflight, emulators,
 * converge, attach, watch loop) lives in the operation.
 */
import { CliError } from '../cli-error.ts';
import { dev } from '../operations/dev.ts';
import type { OperationDeps } from '../operations/shared.ts';

/** The subset of `ParsedArgs` `run()` hands off for the `dev` command. */
export interface DevArgs {
  readonly entry: string;
  readonly name: string | undefined;
  readonly fresh: boolean;
}

/** Injectable seams — the operations' own OperationDeps, under this adapter's historical name. */
export type DevRunDeps = OperationDeps;

/** `[dev] ready:` then one line per endpoint, ordered by address depth (fewest dots first) then lexicographic. Exported for tests. */
export function renderFrontDoor(
  endpoints: readonly { readonly address: string; readonly url: string }[],
): readonly string[] {
  const sorted = [...endpoints].sort((a, b) => {
    const depthA = a.address.split('.').length;
    const depthB = b.address.split('.').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
  return ['[dev] ready:', ...sorted.map((e) => `[dev] ${e.address}  ${e.url}`)];
}

function printFrontDoor(
  endpoints: readonly { readonly address: string; readonly url: string }[],
): void {
  for (const line of renderFrontDoor(endpoints)) console.log(line);
}

/** Runs the full dev pipeline; returns the process exit code. */
export async function runDev(args: DevArgs, deps: DevRunDeps = {}): Promise<number> {
  // Shipped output order: front door → `[dev] logs:` hint → unwatchable lines.
  // The operation emits 'unwatchable' before it returns the session, so those
  // lines are held back until the hint has printed.
  let hintPrinted = false;
  const pendingUnwatchable: string[] = [];
  const result = await dev({
    entry: args.entry,
    name: args.name,
    fresh: args.fresh,
    onEvent: (event) => {
      switch (event.kind) {
        case 'ready':
          printFrontDoor(event.endpoints);
          break;
        case 'unwatchable': {
          const line = `[dev] ${event.address} has no watchable inputs`;
          if (hintPrinted) console.log(line);
          else pendingUnwatchable.push(line);
          break;
        }
        case 'converge-failed':
          console.error('[dev] converge failed — the running app is untouched; still watching.');
          console.error(`\nGenerated stack file: ${event.stackFilePath}`);
          console.error(
            `Run \`${event.reproduceCommand}\` from ${event.cwd} to reproduce this directly.`,
          );
          break;
        case 'rebuild-failed':
          console.error(`[dev] rebuild failed: ${event.message}`);
          break;
        case 'watch-error':
          console.error(`[dev] watch error: ${event.message}`);
          break;
        case 'stopping':
          console.log(
            "[dev] stopping — the app's services are stopping; emulators and data stay up.",
          );
          break;
        case 'stopped':
          console.log('[dev] stopped.');
          break;
      }
    },
    deps,
  });

  if (result.outcome === 'failed') {
    const failure = result.failure;
    if (failure.kind === 'execution' && failure.diagnostics !== undefined) {
      const { exitCode, stackFilePath, reproduceCommand, cwd } = failure.diagnostics;
      console.error(`\nGenerated stack file: ${stackFilePath}`);
      console.error(`Run \`${reproduceCommand}\` from ${cwd} to reproduce this directly.`);
      return exitCode ?? 1;
    }
    throw failure.cause instanceof Error ? failure.cause : new CliError(failure.message);
  }

  const session = result.session;
  // Logs are a separate command, not this view: `dev` supervises many service
  // processes and streaming them all inline drowns the front door and the
  // rebuild notices. `prisma-composer log` tails them on demand.
  console.log(`[dev] logs: prisma-composer log ${args.entry}`);
  hintPrinted = true;
  for (const line of pendingUnwatchable.splice(0)) console.log(line);

  const finish = (): void => {
    void session.stop();
  };

  // alchemy's own library code (imported transitively while loading the
  // app's config/providers) registers its own process-level SIGINT/SIGTERM
  // listeners for ITS OWN in-process resource bookkeeping — irrelevant
  // here, since the actual converge runs in a separate spawned `alchemy`
  // child process (run-alchemy.ts), never in this one. Left in place,
  // whichever of its listeners runs first can call process.exit()
  // synchronously and tear this process down before the watch loop's own
  // async cleanup (stopping the app's services) ever gets a turn. This is
  // this process's OWN signal handling from here on: strip whatever else
  // is registered and become the only listener.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  await session.closed;
  process.off('SIGINT', finish);
  process.off('SIGTERM', finish);
  return 0;
}
