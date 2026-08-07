/**
 * `prisma-composer log <entry> [address]` — the CLI adapter over the
 * programmatic `log()` operation (../operations/execute-log.ts): it owns the
 * SIGINT/SIGTERM → abort wiring, the empty-services notice, and the
 * `[service] line` rendering. Resolution, attach, and the merged stream live
 * in the operation. `dev` no longer streams logs inline (that drowned the
 * front door once it supervises more than one service); this is where logs
 * live.
 */
import { type LogDeps, logWithDeps } from '../operations/log.ts';

/** The subset of `ParsedArgs` `run()` hands off for the `log` command. */
export interface LogArgs {
  readonly entry: string;
  readonly name: string | undefined;
  /** Only this service's lines, by its dotted address (`catalog.service`); every service when absent. */
  readonly address: string | undefined;
  /** Trailing history lines before live output. */
  readonly tail: number;
}

/** Injectable seams — the log operation's own LogDeps, under this adapter's historical name. */
export type LogRunDeps = LogDeps;

/** Runs the log tail until interrupted; returns the process exit code. */
export async function runLog(args: LogArgs, deps: LogRunDeps = {}): Promise<number> {
  const controller = new AbortController();
  const finish = (): void => controller.abort();
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  try {
    const result = await logWithDeps(
      {
        entry: args.entry,
        name: args.name,
        address: args.address,
        tail: args.tail,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === 'stream-failed') {
            console.error(`[log] stream failed: ${event.message}`);
          } else if (event.kind === 'lines-dropped') {
            console.error(
              `[log] falling behind — dropped the ${String(event.count)} oldest lines.`,
            );
          }
        },
      },
      { config: deps.config, identity: deps.identity },
    );

    if (!result.ok) {
      throw result.failure;
    }

    const attached = result.value;
    if (attached.services.length === 0) {
      console.error(
        `[log] no running services for "${attached.appName}" — start it first with \`prisma-composer dev ${args.entry}\`.`,
      );
      return 0;
    }

    for await (const { service, line } of attached.lines) {
      console.log(`[${service}] ${line}`);
    }
  } finally {
    process.off('SIGINT', finish);
    process.off('SIGTERM', finish);
  }

  return 0;
}
