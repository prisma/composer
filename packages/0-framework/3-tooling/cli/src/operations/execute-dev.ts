/**
 * The dev executor — run-dev.ts's pipeline (local-dev spec § 6) with console
 * and signal handling removed: events out through `onEvent`, lifetime owned by
 * the returned DevSession. The operation NEVER touches process signal
 * handlers — the host does (see run-dev.ts). Reached only by lazy import
 * from dev.ts — this module's static graph transitively loads alchemy's
 * provider tree, so the control entry must never import it statically.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Graph, ServiceNode } from '@internal/core';
import type { ContainerInstance, PrismaAppConfig } from '@internal/core/config';
import { containerEnv } from '@internal/core/config';
import type { DevServer } from '@internal/core/deploy';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import { devEnvironmentDir, resolveLocalTargets } from '@internal/core/local-target';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import { devStackRelativePath, writeDevStackFile } from '../dev/generate-dev-stack.ts';
import {
  authoringModuleTargets,
  startWatch,
  type WatchHandle,
  watchTargetsFrom,
} from '../dev/watch.ts';
import { type PipelineDeps, runPipeline } from '../pipeline.ts';
import {
  type AlchemyOutcome,
  alchemyInvocation,
  reproduceCommand,
  spawnAlchemy,
} from '../run-alchemy.ts';
import { validateEnvironmentName } from '../validate-environment.ts';
import type { DevEvent, DevInput, DevSession } from './dev.ts';
import { withEmulatorRetry } from './emulator-retry.ts';
import {
  DEV_ENVIRONMENT,
  type ExtensionId,
  type OperationDeps,
  requireContainerForEnvironment,
  type ServiceEndpoint,
  toStructured,
} from './shared.ts';

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How many lines of a dev server's log the session shows when it starts
 * following it. The emulator clears the log on every fresh start, so these
 * are the current process's own startup lines (the framework's banner, a
 * compile error), written while `prisma dev` waited for it to listen.
 */
const DEV_SERVER_LOG_BACKLOG = 200;

async function mergedEndpoints(
  attachments: readonly LocalTargetAttachment[],
  devServers: Readonly<Record<string, DevServer>>,
): Promise<readonly ServiceEndpoint[]> {
  const lists = await Promise.all(attachments.map((a) => withEmulatorRetry(() => a.endpoints())));
  return lists.flat().map((endpoint) => {
    const server = devServers[endpoint.address];
    return server === undefined ? endpoint : { ...endpoint, devServer: server.display };
  });
}

/** Each service that runs a dev server, in graph order, with its node. */
function devServerNodes(
  graph: Graph,
  devServers: Readonly<Record<string, DevServer>>,
): readonly { readonly address: string; readonly node: ServiceNode; readonly server: DevServer }[] {
  const found: { address: string; node: ServiceNode; server: DevServer }[] = [];
  for (const { id, node } of graph.nodes) {
    const server = devServers[id];
    if (server !== undefined && node.kind === 'service') found.push({ address: id, node, server });
  }
  return found;
}

function devServerUnsupported(
  address: string,
  what: string,
  extension: string,
): CliStructuredError {
  return new CliStructuredError(
    'DEV.DEV_SERVER_UNSUPPORTED',
    `service "${address}" runs a dev server but ${what} — update ${extension}`,
    { meta: { address } },
  );
}

/**
 * ADR-0056's two capability checks, before anything converges: the service's
 * descriptor must be able to lower it without an artifact (`reserve`), and its
 * target's local attachment must be able to run the command (`serve`).
 */
function assertDevServersSupported(
  graph: Graph,
  devServers: Readonly<Record<string, DevServer>>,
  config: PrismaAppConfig,
  attachments: ReadonlyMap<ExtensionId, LocalTargetAttachment>,
): void {
  for (const { address, node } of devServerNodes(graph, devServers)) {
    const descriptor = config.extensions.find((e) => e.id === node.extension)?.nodes[node.type];
    if (descriptor?.kind === 'service' && descriptor.reserve === undefined) {
      throw devServerUnsupported(
        address,
        `its descriptor (${node.extension}/${node.type}) has no \`reserve\` step`,
        node.extension,
      );
    }
    if (attachments.get(node.extension)?.serve === undefined) {
      throw devServerUnsupported(
        address,
        "its target's local attachment has no `serve`",
        node.extension,
      );
    }
  }
}

/** Runs the full dev pipeline; resolves to a running session or a structured failure. */
/** The file's content hash; undefined when it cannot be read, which counts as a change. */
function contentHash(file: string): string | undefined {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

export async function executeDev(
  input: DevInput,
  deps: OperationDeps,
  cwd: string,
): Promise<Result<DevSession, CliStructuredError>> {
  if (process.platform === 'win32') {
    return notOk(
      new CliStructuredError(
        'DEV.PLATFORM_UNSUPPORTED',
        'local dev is not supported on Windows yet.',
      ),
    );
  }

  const { onEvent } = input;
  const environment = input.environment ?? DEV_ENVIRONMENT;
  const devDir = path.join(cwd, devEnvironmentDir(environment));

  let pipeline: Awaited<ReturnType<typeof runPipeline>>;
  let resolved: ReadonlyMap<string, LocalTargetDescriptor>;
  const containers = new Map<ExtensionId, ContainerInstance>();
  // Each participating extension's view of the running app, made before the
  // first converge so a target that cannot run a dev server fails first.
  const attachmentsById = new Map<ExtensionId, LocalTargetAttachment>();

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

  try {
    validateEnvironmentName(environment);
    // The shared prefix (pipeline.ts): entry load, Load, registry coverage,
    // name resolution, assemble.
    const pipelineDeps: PipelineDeps = { runAssembler: deps.runAssembler, devServers: true };
    pipeline = await runPipeline(input.entry, input.name, cwd, input.config, pipelineDeps);
    const { graph, name } = pipeline;
    const config = pipeline.configSource.value;

    // Dev-capability check — resolve every non-build-only extension's lazy
    // `localTarget` thunk ONCE (ADR-0041's lazy reference); its pinned error
    // is structured at origin in core (DEV.TARGET_UNSUPPORTED), and build-only
    // extensions are exempt inside it. Every subsequent hook call runs off
    // this resolved map.
    resolved = await resolveLocalTargets(config);

    // Containers — purely local, resolved before anything else can fail.
    for (const [id, dev] of resolved) {
      let container: ContainerInstance;
      try {
        container = await dev.container.ensure({ appName: name, environment });
      } catch (error) {
        throw toStructured('DEV.CONTAINER_FAILED', error);
      }
      requireContainerForEnvironment('dev', id, dev.container, container, environment);
      containers.set(id, container);
    }

    // `--fresh`: teardown every participant's dev instance, then continue cold.
    if (input.fresh === true) {
      for (const [id, dev] of resolved) {
        if (dev.teardown === undefined) continue;
        try {
          await dev.teardown({ container: containers.get(id), environment });
        } catch (error) {
          throw toStructured('DEV.TEARDOWN_FAILED', error);
        }
      }
    }

    // Preflight — always (dev has no deploy/destroy split).
    for (const [id, dev] of resolved) {
      if (dev.preflight === undefined) continue;
      try {
        await dev.preflight({ graph, container: containers.get(id), environment });
      } catch (error) {
        throw toStructured('DEV.PREFLIGHT_FAILED', error);
      }
    }

    // Emulators — ensure the daemons this topology's node kinds need, and their per-node state.
    for (const [id, dev] of resolved) {
      if (dev.emulators === undefined) continue;
      try {
        await dev.emulators({ graph, container: containers.get(id), devDir });
      } catch (error) {
        throw toStructured('DEV.EMULATOR_FAILED', error);
      }
    }

    for (const [id, dev] of resolved) {
      try {
        attachmentsById.set(id, await dev.attach({ container: containers.get(id), devDir }));
      } catch (error) {
        throw toStructured('DEV.ATTACH_FAILED', error);
      }
    }

    // ADR-0056: say which services run a dev server, and refuse one that
    // cannot, before anything converges.
    const { devServers } = pipeline.assembled;
    assertDevServersSupported(graph, devServers, config, attachmentsById);
    for (const { address, server } of devServerNodes(graph, devServers)) {
      emit({ kind: 'dev-server', address, command: server.display, cwd: server.cwd });
    }
  } catch (error) {
    // Every user-surfaced failure above is structured at its origin or by a
    // site-specific wrap; a non-structured error here is a bug (rule 6).
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }

  const invocation = alchemyInvocation({
    command: 'deploy',
    stackFileRelativePath: devStackRelativePath(environment),
    cwd,
    stage: environment,
    containerEnv: containerEnv(containers),
  });

  const converge = async (): Promise<{ outcome: AlchemyOutcome; stackPath: string }> => {
    let stackPath: string;
    try {
      stackPath = writeDevStackFile({
        entryPath: pipeline.entryModule.path,
        cwd,
        environment,
        configFile: pipeline.configSource.file,
        name: pipeline.name,
        assembled: pipeline.assembled,
      });
    } catch (error) {
      // Stack-file write I/O is structured at the catch that knows (rule 6).
      throw toStructured('DEV.STACK_WRITE_FAILED', error);
    }
    let outcome: AlchemyOutcome;
    try {
      outcome = await (deps.alchemy ?? spawnAlchemy)(invocation);
    } catch (error) {
      if (CliStructuredError.is(error)) throw error;
      throw new CliStructuredError('DEV.CONVERGE_FAILED', failureMessage(error), {
        cause: error,
        meta: {
          diagnostics: {
            exitCode: undefined,
            stackFilePath: stackPath,
            reproduceCommand: reproduceCommand(invocation),
            cwd,
          },
        },
      });
    }
    return { outcome, stackPath };
  };

  // A failed first converge can leave some services started; the session never began, so stop them.
  const stopStartedServices = async (): Promise<void> => {
    for (const attachment of attachmentsById.values()) {
      try {
        await attachment.stopApp();
      } catch {
        // Best effort: the converge failure is the error to report.
      }
    }
  };

  /**
   * ADR-0056's serve step: run every dev server on its service's instance,
   * in graph order. The emulator decides whether anything restarts; a
   * restart is reported through `onRestarted`.
   */
  const serveDevServers = async (
    graph: Graph,
    devServers: Readonly<Record<string, DevServer>>,
    onRestarted?: (address: string, server: DevServer) => void,
  ): Promise<void> => {
    for (const { address, node, server } of devServerNodes(graph, devServers)) {
      const attachment = attachmentsById.get(node.extension);
      if (attachment?.serve === undefined) {
        throw devServerUnsupported(
          address,
          "its target's local attachment has no `serve`",
          node.extension,
        );
      }
      const serve = attachment.serve.bind(attachment);
      let restarted: boolean;
      try {
        ({ restarted } = await withEmulatorRetry(() => serve({ address, node, server })));
      } catch (error) {
        throw toStructured('DEV.SERVICE_START_FAILED', error);
      }
      if (restarted) onRestarted?.(address, server);
    }
  };

  // Write the dev stack file and converge. Inside the try: a stray
  // `.prisma-composer` FILE, a full disk, or a spawn that throws must come
  // back as a failure result, not a rejection out of dev().
  let first: { outcome: AlchemyOutcome; stackPath: string };
  try {
    first = await converge();
  } catch (error) {
    await stopStartedServices();
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
  const firstStatus = first.outcome.signal !== null ? null : (first.outcome.exitCode ?? 1);
  if (firstStatus !== 0) {
    await stopStartedServices();
    return notOk(
      new CliStructuredError(
        'DEV.CONVERGE_FAILED',
        first.outcome.signal !== null
          ? `alchemy deploy was interrupted by ${first.outcome.signal}.`
          : `alchemy deploy exited with status ${String(firstStatus)}.`,
        {
          meta: {
            ...(first.outcome.signal !== null
              ? { signal: first.outcome.signal }
              : { exitCode: firstStatus }),
            diagnostics: {
              exitCode: firstStatus ?? undefined,
              ...(first.outcome.signal !== null ? { signal: first.outcome.signal } : {}),
              stackFilePath: first.stackPath,
              reproduceCommand: reproduceCommand(invocation, first.outcome),
              cwd,
            },
          },
        },
      ),
    );
  }

  // Attach: start every stopped service (session resume — a no-op converge
  // cannot restart what a previous session's Ctrl-C stopped), then report the
  // front door. On ANY failure before the session is handed over — a partial
  // startServices, the endpoint merge, watch setup — put the machine back the
  // way a previous Ctrl-C left it: stop the watcher (if it started) and every
  // service that started, THEN surface the failure. A session that never began
  // must not leave anything half-running.
  const attachments: LocalTargetAttachment[] = [...attachmentsById.values()];
  const started: LocalTargetAttachment[] = [];
  let watch: WatchHandle | undefined;
  let configWatch: WatchHandle | undefined;
  // Ends the inline following of dev servers' output when the session stops.
  const following = new AbortController();
  try {
    for (const attachment of attachments) {
      // Recorded BEFORE the call: startServices can start some services and
      // then throw, and a partially-started attachment must be rolled back by
      // the catch below too (stopApp failures are already swallowed
      // there, so stopping a never-started attachment is harmless).
      started.push(attachment);
      try {
        await withEmulatorRetry(() => attachment.startServices());
      } catch (error) {
        throw toStructured('DEV.SERVICE_START_FAILED', error);
      }
    }
    // Dev servers run on their instances once the converge and the resume
    // are done, so the environment they are given is the converged one.
    await serveDevServers(pipeline.graph, pipeline.assembled.devServers);
    let endpoints: readonly ServiceEndpoint[];
    try {
      endpoints = await mergedEndpoints(attachments, pipeline.assembled.devServers);
    } catch (error) {
      throw toStructured('DEV.ATTACH_FAILED', error);
    }
    emit({ kind: 'ready', endpoints });
    if (input.detach === true) {
      const closed = Promise.resolve();
      return ok({ endpoints, stop: () => closed, closed });
    }

    // The foreground session shows what its dev servers write, prefixed with
    // the address; services that run artifacts are not streamed (ADR-0056).
    for (const [id, attachment] of attachmentsById) {
      const addresses = devServerNodes(pipeline.graph, pipeline.assembled.devServers)
        .filter(({ node }) => node.extension === id)
        .map(({ address }) => address);
      if (addresses.length === 0) continue;
      void (async () => {
        try {
          for await (const { service, line } of attachment.logs(following.signal, {
            tail: DEV_SERVER_LOG_BACKLOG,
            addresses,
          })) {
            emit({ kind: 'dev-server-output', address: service, line });
          }
        } catch {
          // Following is a view: losing it never ends the session.
        }
      })();
    }

    // Watch loop until the session is stopped: rebuild → re-assemble →
    // re-converge; a converge failure keeps the running app and keeps watching.
    // Authoring modules are watched too, so an app whose services all run dev
    // servers still reconverges on a topology edit (ADR-0056).
    const bundleWatch = watchTargetsFrom(pipeline.assembled.bundles);
    const targets = [
      ...bundleWatch.targets,
      ...authoringModuleTargets(pipeline.entryModule.path, pipeline.graph),
    ];
    for (const address of bundleWatch.unwatchable) {
      emit({ kind: 'unwatchable', address });
    }

    const watchDeps: PipelineDeps = { runAssembler: deps.runAssembler, devServers: true };
    const watchFiles = deps.watch ?? startWatch;
    const onWatchError = (error: unknown): void =>
      emit({ kind: 'watch-error', message: failureMessage(error) });
    const configFile = pipeline.configSource.file;
    const startedConfig = contentHash(configFile);
    let configChanged = false;
    // Read on every event, not only from the config watcher: a build watch
    // on a directory that contains the file can fire first.
    const pausedForConfig = (): boolean => {
      if (!configChanged && contentHash(configFile) === startedConfig) return false;
      configChanged = true;
      emit({ kind: 'config-changed', file: configFile });
      return true;
    };
    configWatch = watchFiles(
      [{ address: configFile, paths: [configFile] }],
      () => void pausedForConfig(),
      onWatchError,
    );
    // The whole rebuild is inside one try/catch: it runs fire-and-forget, so
    // anything escaping it would be an unhandled rejection killing the
    // process — the exact opposite of "a converge failure keeps the running
    // app and keeps watching".
    const rebuild = async (): Promise<void> => {
      try {
        const rePipeline = await runPipeline(input.entry, input.name, cwd, input.config, watchDeps);
        const stackPath = writeDevStackFile({
          entryPath: rePipeline.entryModule.path,
          cwd,
          environment,
          configFile: rePipeline.configSource.file,
          name: rePipeline.name,
          assembled: rePipeline.assembled,
        });
        const outcome = await (deps.alchemy ?? spawnAlchemy)(invocation);
        if (outcome.signal !== null || outcome.exitCode !== 0) {
          emit({
            kind: 'converge-failed',
            stackFilePath: stackPath,
            reproduceCommand: reproduceCommand(invocation, outcome),
            cwd,
          });
          return;
        }
        // A converge can move what a dev server's environment holds (a
        // dependency's port, a rotated key); the emulator restarts it then.
        await serveDevServers(
          rePipeline.graph,
          rePipeline.assembled.devServers,
          (address, server) =>
            emit({ kind: 'dev-server-restarted', address, command: server.display }),
        );
        emit({
          kind: 'ready',
          endpoints: await mergedEndpoints(attachments, rePipeline.assembled.devServers),
        });
      } catch (error) {
        emit({ kind: 'rebuild-failed', message: failureMessage(error) });
      }
    };
    // One rebuild at a time: a rebuild rewrites every service's artifact
    // directory, which the previous rebuild's converge child may still be
    // reading. Changes during a rebuild coalesce into one more after it.
    let rebuilding = false;
    let changedDuringRebuild = false;
    const rebuildUntilSettled = async (): Promise<void> => {
      rebuilding = true;
      do {
        changedDuringRebuild = false;
        await rebuild();
      } while (changedDuringRebuild && !pausedForConfig());
      rebuilding = false;
    };
    watch = watchFiles(
      targets,
      () => {
        if (pausedForConfig()) return;
        if (rebuilding) {
          changedDuringRebuild = true;
          return;
        }
        void rebuildUntilSettled();
      },
      onWatchError,
    );
    // A rebuild finishing before the OS-level watches attach would otherwise
    // be missed entirely — wait until watching is real before handing over.
    const startedWatch = watch;
    const startedConfigWatch = configWatch;
    await Promise.all([watch.ready, configWatch.ready]);

    let stopping = false;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const stop = (): Promise<void> => {
      if (!stopping) {
        stopping = true;
        emit({ kind: 'stopping' });
        following.abort();
        startedWatch.stop();
        startedConfigWatch.stop();
        void (async () => {
          // A service that refuses to stop is surfaced, not swallowed —
          // teardown continues, `stopped` still fires, `closed` still settles.
          for (const attachment of attachments) {
            try {
              await attachment.stopApp();
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
    return ok(session);
  } catch (error) {
    // Cleanup runs whatever the error's shape; only structured failures come
    // back as values — a non-structured escape is a bug and throws (rule 6).
    following.abort();
    watch?.stop();
    configWatch?.stop();
    await Promise.all(started.map((a) => a.stopApp().catch(() => undefined)));
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}
