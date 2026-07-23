/**
 * Local-dev spec § 6 `run-dev.ts`: `prisma-composer dev <entry>` — steps 1–6
 * of `run()` reused via pipeline.ts, then the dev-only pipeline: capability
 * check, containers, `--fresh` teardown, preflight, emulators, converge
 * against a generated dev stack file, attach (front door + merged logs),
 * watch loop until interrupted.
 */
import * as path from 'node:path';
import type { RunAssembler } from '@internal/assemble';
import type {
  ContainerInstance,
  DevAttachment,
  ExtensionDescriptor,
  PrismaAppConfig,
} from '@internal/core/config';
import { containerEnv, DEV_DIR, isBuildOnlyExtension } from '@internal/core/config';
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

/** Every configured extension that participates in dev (build-only extensions are exempt — ADR-0041). */
function devParticipants(config: PrismaAppConfig): readonly ExtensionDescriptor[] {
  return config.extensions.filter((extension) => !isBuildOnlyExtension(extension));
}

function checkDevCapability(config: PrismaAppConfig): void {
  for (const extension of devParticipants(config)) {
    if (extension.dev === undefined) {
      throw new CliError(
        `extension "${extension.id}" has no local dev support (no \`dev\` descriptor) — remove ` +
          'it from prisma-composer.config.ts or update it.',
      );
    }
  }
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

async function mergedEndpoints(
  attachments: readonly DevAttachment[],
): Promise<readonly { readonly address: string; readonly url: string }[]> {
  const lists = await Promise.all(attachments.map((a) => a.endpoints()));
  return lists.flat();
}

/** Pumps every attachment's merged log stream to stdout, each line prefixed `[<service>] `, until `signal` aborts. */
function pumpLogs(attachments: readonly DevAttachment[], signal: AbortSignal): void {
  for (const attachment of attachments) {
    void (async () => {
      try {
        for await (const { service, line } of attachment.logs(signal)) {
          if (signal.aborted) return;
          console.log(`[${service}] ${line}`);
        }
      } catch {
        // signal aborted mid-iteration — nothing else to do
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

  // 2. Dev-capability check — every non-build-only extension declares `dev`.
  checkDevCapability(config);
  const participants = devParticipants(config);

  // 3. Containers — purely local, resolved before anything else can fail.
  const containers = new Map<string, ContainerInstance>();
  for (const extension of participants) {
    const dev = extension.dev;
    if (dev === undefined) continue; // checkDevCapability already proved this can't happen
    try {
      containers.set(extension.id, await dev.container.ensure({ appName: name, stage: undefined }));
    } catch (error) {
      throw toCliError(error);
    }
  }

  // 4. `--fresh`: teardown every participant's dev instance, then continue cold.
  if (args.fresh) {
    for (const extension of participants) {
      const dev = extension.dev;
      if (dev?.teardown === undefined) continue;
      try {
        await dev.teardown({ container: containers.get(extension.id), stage: undefined });
      } catch (error) {
        throw toCliError(error);
      }
    }
  }

  // 5. Preflight — always (dev has no deploy/destroy split).
  for (const extension of participants) {
    const dev = extension.dev;
    if (dev?.preflight === undefined) continue;
    try {
      await dev.preflight({ graph, container: containers.get(extension.id), stage: undefined });
    } catch (error) {
      throw toCliError(error);
    }
  }

  // 6. Emulators — ensure the daemons this topology's node kinds need.
  for (const extension of participants) {
    const dev = extension.dev;
    if (dev?.emulators === undefined) continue;
    try {
      await dev.emulators({ graph, container: containers.get(extension.id), devDir });
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

  // 8. Attach: endpoints, merged logs, print the front door.
  const attachments: DevAttachment[] = [];
  for (const extension of participants) {
    const dev = extension.dev;
    if (dev === undefined) continue;
    attachments.push(await dev.attach({ container: containers.get(extension.id), devDir }));
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

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stopWatch = startWatch(targets, () => {
      void (async () => {
        const rePipeline = await runPipeline(args.entry, args.name, cwd, pipelineDeps).catch(
          (error: unknown) => {
            console.error(
              `[dev] rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
          },
        );
        if (rePipeline === undefined) return;
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
      })();
    });

    const finish = (): void => {
      if (stopping) return;
      stopping = true;
      stopWatch();
      void (async () => {
        logsController.abort();
        for (const attachment of attachments) {
          await attachment.stopServices().catch(() => undefined);
        }
        resolve();
      })();
    };

    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });

  return 0;
}
