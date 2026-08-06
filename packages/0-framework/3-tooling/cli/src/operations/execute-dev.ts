/**
 * The dev executor — run-dev.ts's pipeline (local-dev spec § 6) with console
 * and signal handling removed: events out through `onEvent`, lifetime owned by
 * the returned DevSession. The operation NEVER touches process signal
 * handlers — the host does (see run-dev.ts). Reached only by lazy import
 * from dev.ts — this module's static graph transitively loads alchemy's
 * provider tree, so the control entry must never import it statically.
 */
import * as path from 'node:path';
import type { ContainerInstance } from '@internal/core/config';
import { containerEnv } from '@internal/core/config';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliError } from '../cli-error.ts';
import { DEV_STACK_RELATIVE_PATH, writeDevStackFile } from '../dev/generate-dev-stack.ts';
import { startWatch, type WatchHandle, watchTargetsFrom } from '../dev/watch.ts';
import { type PipelineDeps, runPipeline } from '../pipeline.ts';
import { runAlchemy } from '../run-alchemy.ts';
import type { DevEvent, DevInput, DevSession, DevStartResult } from './dev.ts';
import { withEmulatorRetry } from './emulator-retry.ts';
import type { ExtensionId, OperationDeps, ServiceEndpoint } from './shared.ts';

function toCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : String(error), { cause: error });
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mergedEndpoints(
  attachments: readonly LocalTargetAttachment[],
): Promise<readonly ServiceEndpoint[]> {
  const lists = await Promise.all(attachments.map((a) => withEmulatorRetry(() => a.endpoints())));
  return lists.flat();
}

/** Runs the full dev pipeline; resolves to a running session or a structured failure. */
export async function executeDev(
  input: DevInput,
  deps: OperationDeps,
  cwd: string,
): Promise<DevStartResult> {
  if (process.platform === 'win32') {
    return {
      outcome: 'failed',
      failure: {
        kind: 'unsupported-platform',
        message: 'local dev is not supported on Windows yet.',
      },
    };
  }

  const { onEvent } = input;
  const devDir = path.join(cwd, DEV_DIR);

  let pipeline: Awaited<ReturnType<typeof runPipeline>>;
  let resolved: ReadonlyMap<string, LocalTargetDescriptor>;
  const containers = new Map<ExtensionId, ContainerInstance>();

  try {
    // The shared prefix (pipeline.ts): config discovery/load, entry load,
    // Load, registry coverage, name resolution, assemble.
    const pipelineDeps: PipelineDeps = { runAssembler: deps.runAssembler, config: deps.config };
    pipeline = await runPipeline(input.entry, input.name, cwd, pipelineDeps);
    const { config, graph, name } = pipeline;

    // Dev-capability check — resolve every non-build-only extension's lazy
    // `localTarget` thunk ONCE (ADR-0041's lazy reference); its pinned error
    // names any extension without local-target support, and build-only
    // extensions are exempt inside it. Every subsequent hook call runs off
    // this resolved map.
    try {
      resolved = await resolveLocalTargets(config);
    } catch (error) {
      throw toCliError(error);
    }

    // Containers — purely local, resolved before anything else can fail.
    for (const [id, dev] of resolved) {
      try {
        containers.set(id, await dev.container.ensure({ appName: name, stage: undefined }));
      } catch (error) {
        throw toCliError(error);
      }
    }

    // `--fresh`: teardown every participant's dev instance, then continue cold.
    if (input.fresh === true) {
      for (const [id, dev] of resolved) {
        if (dev.teardown === undefined) continue;
        try {
          await dev.teardown({ container: containers.get(id), stage: undefined });
        } catch (error) {
          throw toCliError(error);
        }
      }
    }

    // Preflight — always (dev has no deploy/destroy split).
    for (const [id, dev] of resolved) {
      if (dev.preflight === undefined) continue;
      try {
        await dev.preflight({ graph, container: containers.get(id), stage: undefined });
      } catch (error) {
        throw toCliError(error);
      }
    }

    // Emulators — ensure the daemons this topology's node kinds need.
    for (const [id, dev] of resolved) {
      if (dev.emulators === undefined) continue;
      try {
        await dev.emulators({ graph, container: containers.get(id), devDir });
      } catch (error) {
        throw toCliError(error);
      }
    }
  } catch (error) {
    return {
      outcome: 'failed',
      failure: { kind: 'pipeline', message: failureMessage(error), cause: error },
    };
  }

  const reproduceCommand = `alchemy deploy ${DEV_STACK_RELATIVE_PATH} --yes --stage dev`;

  const converge = (): { status: number; stackPath: string } => {
    const stackPath = writeDevStackFile({
      entryPath: pipeline.entryModule.path,
      cwd,
      configPath: pipeline.configPath,
      name: pipeline.name,
      assembled: pipeline.assembled,
    });
    const status = (deps.alchemy ?? runAlchemy)({
      command: 'deploy',
      stackFileRelativePath: DEV_STACK_RELATIVE_PATH,
      cwd,
      stage: 'dev',
      containerEnv: containerEnv(containers),
    });
    return { status, stackPath };
  };

  // Write the dev stack file and converge. Inside the try: a stray
  // `.prisma-composer` FILE, a full disk, or a spawn that throws must come
  // back as a failure result, not a rejection out of dev().
  let first: { status: number; stackPath: string };
  try {
    first = converge();
  } catch (error) {
    return {
      outcome: 'failed',
      failure: { kind: 'pipeline', message: failureMessage(error), cause: error },
    };
  }
  if (first.status !== 0) {
    return {
      outcome: 'failed',
      failure: {
        kind: 'execution',
        message: `alchemy deploy exited with status ${first.status}.`,
        diagnostics: {
          exitCode: first.status,
          stackFilePath: first.stackPath,
          reproduceCommand,
          cwd,
        },
      },
    };
  }

  // A host onEvent that throws is the host's bug, but it must not kill the
  // session's own control flow — above all it must never prevent `closed`
  // from settling, and a throw inside the fire-and-forget watch callback
  // would be an unhandled rejection killing the process.
  const emit = (event: DevEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // Swallowed: rendering is the host's; its failures are not the session's.
    }
  };

  // Attach: start every stopped service (session resume — a no-op converge
  // cannot restart what a previous session's Ctrl-C stopped), then report the
  // front door. On ANY failure before the session is handed over — a partial
  // startServices, the endpoint merge, watch setup — put the machine back the
  // way a previous Ctrl-C left it: stop the watcher (if it started) and every
  // service that started, THEN return the failure. A session that never began
  // must not leave anything half-running.
  const attachments: LocalTargetAttachment[] = [];
  const started: LocalTargetAttachment[] = [];
  let watch: WatchHandle | undefined;
  try {
    for (const [id, dev] of resolved) {
      attachments.push(await dev.attach({ container: containers.get(id), devDir }));
    }
    for (const attachment of attachments) {
      try {
        await withEmulatorRetry(() => attachment.startServices());
        started.push(attachment);
      } catch (error) {
        throw toCliError(error);
      }
    }
    const endpoints = await mergedEndpoints(attachments);
    emit({ kind: 'ready', endpoints });

    // Watch loop until the session is stopped: rebuild → re-assemble →
    // re-converge; a converge failure keeps the running app and keeps watching.
    const { targets, unwatchable } = watchTargetsFrom(pipeline.assembled.bundles);
    for (const address of unwatchable) {
      emit({ kind: 'unwatchable', address });
    }

    const watchDeps: PipelineDeps = { runAssembler: deps.runAssembler, config: deps.config };
    watch = startWatch(
      targets,
      () => {
        // The whole rebuild is inside one try/catch: this runs fire-and-forget,
        // so anything escaping it would be an unhandled rejection killing the
        // process — the exact opposite of "a converge failure keeps the running
        // app and keeps watching".
        void (async () => {
          try {
            const rePipeline = await runPipeline(input.entry, input.name, cwd, watchDeps);
            const stackPath = writeDevStackFile({
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
              emit({ kind: 'converge-failed', stackFilePath: stackPath, reproduceCommand, cwd });
              return;
            }
            emit({ kind: 'ready', endpoints: await mergedEndpoints(attachments) });
          } catch (error) {
            emit({ kind: 'rebuild-failed', message: failureMessage(error) });
          }
        })();
      },
      (error) => emit({ kind: 'watch-error', message: failureMessage(error) }),
    );
    // A rebuild finishing before the OS-level watches attach would otherwise
    // be missed entirely — wait until watching is real before handing over.
    const startedWatch = watch;
    await watch.ready;

    let stopping = false;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const stop = (): Promise<void> => {
      if (!stopping) {
        stopping = true;
        emit({ kind: 'stopping' });
        startedWatch.stop();
        void (async () => {
          // A service that refuses to stop is surfaced, not swallowed —
          // teardown continues, `stopped` still fires, `closed` still settles.
          for (const attachment of attachments) {
            try {
              await attachment.stopServices();
            } catch (error) {
              emit({ kind: 'stop-error', message: failureMessage(error) });
            }
          }
          emit({ kind: 'stopped' });
          resolveClosed();
        })();
      }
      return closed;
    };

    const session: DevSession = { endpoints, stop, closed };
    return { outcome: 'started', session };
  } catch (error) {
    watch?.stop();
    await Promise.all(started.map((a) => a.stopServices().catch(() => undefined)));
    return {
      outcome: 'failed',
      failure: { kind: 'pipeline', message: failureMessage(error), cause: error },
    };
  }
}
