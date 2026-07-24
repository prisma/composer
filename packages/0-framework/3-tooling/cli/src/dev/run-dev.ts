/**
 * Local-dev spec § 6 `run-dev.ts`: `prisma-composer dev <entry>` — steps 1–6
 * of `run()` reused via pipeline.ts, then the dev-only pipeline: capability
 * check, containers, `--fresh` teardown, preflight, emulators, converge
 * against a generated dev stack file, attach (front door + merged logs),
 * watch loop until interrupted.
 */
import * as path from 'node:path';
import type { RunAssembler } from '@internal/assemble';
import type { ContainerInstance, PrismaAppConfig } from '@internal/core/config';
import { containerEnv } from '@internal/core/config';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliError } from '../cli-error.ts';
import { type PipelineDeps, runPipeline } from '../pipeline.ts';
import { type RunAlchemyInput, runAlchemy } from '../run-alchemy.ts';
import { DEV_STACK_RELATIVE_PATH, writeDevStackFile } from './generate-dev-stack.ts';
import { startWatch, watchTargetsFrom } from './watch.ts';

/** The subset of `ParsedArgs` `run()` hands off for the `dev` command. */
export interface DevArgs {
  readonly entry: string;
  readonly name: string | undefined;
  readonly fresh: boolean;
}

/** Injectable seams — the same shapes `run()`'s `RunDeps` offers deploy/destroy. */
export interface DevRunDeps {
  readonly runAssembler?: RunAssembler;
  readonly alchemy?: (input: RunAlchemyInput) => number;
  readonly config?: PrismaAppConfig;
}

function toCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : String(error));
}

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

const EMULATOR_RETRY_ATTEMPTS = 5;
const EMULATOR_RETRY_DELAY_MS = 500;

/** An emulator admin call right after a converge that just PUT dozens of resources through the same daemon can hit a transient refused/reset connection — a brief loopback hiccup under load, not a real failure. Retried before giving up. Applies to every attach admin call the dev session makes (`startServices`, `endpoints`). */
async function withEmulatorRetry<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EMULATOR_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt < EMULATOR_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, EMULATOR_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mergedEndpoints(
  attachments: readonly LocalTargetAttachment[],
): Promise<readonly { readonly address: string; readonly url: string }[]> {
  const lists = await Promise.all(attachments.map((a) => withEmulatorRetry(() => a.endpoints())));
  return lists.flat();
}

/** Pumps every attachment's merged log stream to stdout, each line prefixed `[<service>] `, until `signal` aborts. */
function pumpLogs(attachments: readonly LocalTargetAttachment[], signal: AbortSignal): void {
  for (const attachment of attachments) {
    void (async () => {
      try {
        for await (const { service, line } of attachment.logs(signal)) {
          if (signal.aborted) return;
          console.log(`[${service}] ${line}`);
        }
      } catch (error) {
        // Quiet only for the abort that ends every session; a genuinely
        // broken stream is said out loud instead of logs just going silent.
        if (!signal.aborted) {
          console.error(
            `[dev] log stream failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
  }
}

/** Runs the full dev pipeline; returns the process exit code. */
export async function runDev(args: DevArgs, deps: DevRunDeps = {}): Promise<number> {
  if (process.platform === 'win32') {
    throw new CliError('local dev is not supported on Windows yet.');
  }

  const cwd = process.cwd();
  const devDir = path.join(cwd, DEV_DIR);

  // 1–6. The shared prefix (pipeline.ts): config discovery/load, entry load,
  // Load, registry coverage, name resolution, assemble.
  const pipelineDeps: PipelineDeps = { runAssembler: deps.runAssembler, config: deps.config };
  const { configPath, config, entryModule, graph, name, assembled } = await runPipeline(
    args.entry,
    args.name,
    cwd,
    pipelineDeps,
  );

  // 2. Dev-capability check — resolve every non-build-only extension's lazy
  // `localTarget` thunk ONCE (ADR-0041's lazy reference); its pinned error
  // names any extension without local-target support, and build-only
  // extensions are exempt inside it. Every subsequent hook call runs off
  // this resolved map.
  let resolved: ReadonlyMap<string, LocalTargetDescriptor>;
  try {
    resolved = await resolveLocalTargets(config);
  } catch (error) {
    throw toCliError(error);
  }

  // 3. Containers — purely local, resolved before anything else can fail.
  const containers = new Map<string, ContainerInstance>();
  for (const [id, dev] of resolved) {
    try {
      containers.set(id, await dev.container.ensure({ appName: name, stage: undefined }));
    } catch (error) {
      throw toCliError(error);
    }
  }

  // 4. `--fresh`: teardown every participant's dev instance, then continue cold.
  if (args.fresh) {
    for (const [id, dev] of resolved) {
      if (dev.teardown === undefined) continue;
      try {
        await dev.teardown({ container: containers.get(id), stage: undefined });
      } catch (error) {
        throw toCliError(error);
      }
    }
  }

  // 5. Preflight — always (dev has no deploy/destroy split).
  for (const [id, dev] of resolved) {
    if (dev.preflight === undefined) continue;
    try {
      await dev.preflight({ graph, container: containers.get(id), stage: undefined });
    } catch (error) {
      throw toCliError(error);
    }
  }

  // 6. Emulators — ensure the daemons this topology's node kinds need.
  for (const [id, dev] of resolved) {
    if (dev.emulators === undefined) continue;
    try {
      await dev.emulators({ graph, container: containers.get(id), devDir });
    } catch (error) {
      throw toCliError(error);
    }
  }

  const converge = (): number => {
    const stackPath = writeDevStackFile({
      entryPath: entryModule.path,
      cwd,
      configPath,
      name,
      assembled,
    });
    const status = (deps.alchemy ?? runAlchemy)({
      command: 'deploy',
      stackFileRelativePath: DEV_STACK_RELATIVE_PATH,
      cwd,
      stage: 'dev',
      containerEnv: containerEnv(containers),
    });
    if (status !== 0) {
      console.error(`\nGenerated stack file: ${stackPath}`);
      console.error(
        `Run \`alchemy deploy ${DEV_STACK_RELATIVE_PATH} --yes --stage dev\` from ${cwd} ` +
          'to reproduce this directly.',
      );
    }
    return status;
  };

  // 7. Write the dev stack file and converge.
  const firstStatus = converge();
  if (firstStatus !== 0) return firstStatus;

  // 8. Attach: start every stopped service (session resume — a no-op converge
  // cannot restart what a previous session's Ctrl-C stopped), then print the
  // front door and pump merged logs.
  const attachments: LocalTargetAttachment[] = [];
  for (const [id, dev] of resolved) {
    attachments.push(await dev.attach({ container: containers.get(id), devDir }));
  }
  // On a partial failure, put the already-started attachments back to
  // stopped — a session that never began should leave the machine exactly as
  // the previous Ctrl-C did, not half-running.
  const started: LocalTargetAttachment[] = [];
  for (const attachment of attachments) {
    try {
      await withEmulatorRetry(() => attachment.startServices());
      started.push(attachment);
    } catch (error) {
      await Promise.all(started.map((a) => a.stopServices().catch(() => undefined)));
      throw toCliError(error);
    }
  }
  printFrontDoor(await mergedEndpoints(attachments));

  const logsController = new AbortController();
  pumpLogs(attachments, logsController.signal);

  // 9. Watch loop until SIGINT/SIGTERM: rebuild → re-assemble → re-converge;
  // a converge failure keeps the running app and keeps watching.
  const { targets, unwatchable } = watchTargetsFrom(assembled.bundles);
  for (const address of unwatchable) {
    console.log(`[dev] ${address} has no watchable inputs`);
  }

  const watch = startWatch(targets, () => {
    // The whole rebuild is inside one try/catch: this runs fire-and-forget,
    // so anything escaping it would be an unhandled rejection killing the
    // process — the exact opposite of "a converge failure keeps the running
    // app and keeps watching".
    void (async () => {
      try {
        const rePipeline = await runPipeline(args.entry, args.name, cwd, pipelineDeps);
        writeDevStackFile({
          entryPath: rePipeline.entryModule.path,
          cwd,
          configPath: rePipeline.configPath,
          name: rePipeline.name,
          assembled: rePipeline.assembled,
        });
        const status = (deps.alchemy ?? runAlchemy)({
          command: 'deploy',
          stackFileRelativePath: DEV_STACK_RELATIVE_PATH,
          cwd,
          stage: 'dev',
          containerEnv: containerEnv(containers),
        });
        if (status !== 0) {
          console.error('[dev] converge failed — the running app is untouched; still watching.');
          return;
        }
        printFrontDoor(await mergedEndpoints(attachments));
      } catch (error) {
        console.error(
          `[dev] rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  });
  // A rebuild finishing before the OS-level watches attach would otherwise
  // be missed entirely — wait until watching is real before handing over.
  await watch.ready;

  await new Promise<void>((resolve) => {
    let stopping = false;

    const finish = (): void => {
      if (stopping) return;
      stopping = true;
      console.log("[dev] stopping — the app's services are stopping; emulators and data stay up.");
      watch.stop();
      void (async () => {
        logsController.abort();
        for (const attachment of attachments) {
          await attachment.stopServices().catch(() => undefined);
        }
        console.log('[dev] stopped.');
        resolve();
      })();
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
  });

  return 0;
}
