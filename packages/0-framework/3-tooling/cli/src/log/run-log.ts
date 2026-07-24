/**
 * `prisma-composer log <entry> [address]` — tail the merged logs of an
 * already-running local app. It resolves the app the way `dev` does (config →
 * localTarget → container → attach) but calls only the attachment's `logs()`
 * view: it neither builds, provisions, starts, nor stops anything. `dev` no
 * longer streams logs inline (that drowned the front door once it supervises
 * more than one service); this is where logs live.
 */
import * as path from 'node:path';
import type { PrismaAppConfig } from '@internal/core/config';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliError } from '../cli-error.ts';
import { type AppIdentity, resolveAppIdentity } from '../pipeline.ts';

/** The subset of `ParsedArgs` `run()` hands off for the `log` command. */
export interface LogArgs {
  readonly entry: string;
  readonly name: string | undefined;
  /** Only this service's lines, by its dotted address (`catalog.service`); every service when absent. */
  readonly address: string | undefined;
  /** Trailing history lines before live output. */
  readonly tail: number;
}

export interface LogRunDeps {
  /** Substituted for the c12 evaluation of the discovered config file (discovery still runs). */
  readonly config?: PrismaAppConfig | undefined;
  /** Overrides the identity resolution (config + name) — lets tests skip a real entry module. */
  readonly identity?: AppIdentity | undefined;
}

function toCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : String(error));
}

/** Runs the log tail until interrupted; returns the process exit code. */
export async function runLog(args: LogArgs, deps: LogRunDeps = {}): Promise<number> {
  if (process.platform === 'win32') {
    throw new CliError('local dev is not supported on Windows yet.');
  }

  const cwd = process.cwd();
  const devDir = path.join(cwd, DEV_DIR);

  const { config, name } =
    deps.identity ??
    (await resolveAppIdentity(args.entry, args.name, cwd, { config: deps.config }));

  let resolved: ReadonlyMap<string, LocalTargetDescriptor>;
  try {
    resolved = await resolveLocalTargets(config);
  } catch (error) {
    throw toCliError(error);
  }

  const attachments: LocalTargetAttachment[] = [];
  for (const target of resolved.values()) {
    try {
      const container = await target.container.ensure({ appName: name, stage: undefined });
      attachments.push(await target.attach({ container, devDir }));
    } catch (error) {
      throw toCliError(error);
    }
  }

  const services = (await Promise.all(attachments.map((a) => a.endpoints()))).flat();
  if (services.length === 0) {
    console.error(
      `[log] no running services for "${name}" — start it first with \`prisma-composer dev ${args.entry}\`.`,
    );
    return 0;
  }
  if (args.address !== undefined && !services.some((s) => s.address === args.address)) {
    throw new CliError(
      `no service "${args.address}" in "${name}" — running services: ${services
        .map((s) => s.address)
        .join(', ')}.`,
    );
  }

  const controller = new AbortController();
  const finish = (): void => controller.abort();
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  try {
    await Promise.all(
      attachments.map(async (attachment) => {
        try {
          for await (const { service, line } of attachment.logs(controller.signal, {
            tail: args.tail,
          })) {
            if (controller.signal.aborted) return;
            if (args.address !== undefined && service !== args.address) continue;
            console.log(`[${service}] ${line}`);
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error(
              `[log] stream failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }),
    );
  } finally {
    process.off('SIGINT', finish);
    process.off('SIGTERM', finish);
  }

  return 0;
}
