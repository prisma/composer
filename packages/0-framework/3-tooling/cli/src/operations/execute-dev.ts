/**
 * The dev executor (local-dev spec § 6): events out through `onEvent`,
 * lifetime owned by the returned DevSession. Every converge lowers the app
 * against the local target and runs Alchemy's plan and apply in this process,
 * through the app's own install (`loadAppConverge`, ADR-0064). The operation
 * NEVER touches process signal handlers; the host does. Reached only by lazy
 * import from dev.ts: this module's static graph transitively loads alchemy's
 * provider tree, so the control entry must never import it statically.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Graph, ModuleNode, ServiceNode } from '@internal/core';
import type { ContainerInstance, NamedSecrets, PrismaAppConfig } from '@internal/core/config';
import type { DevServer } from '@internal/core/deploy';
import { secretsKeys } from '@internal/core/deploy';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import { devEnvironmentDir, resolveLocalTargets } from '@internal/core/local-target';
import { CliStructuredError, InternalError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import { removeLeftoverAppConfigurationFiles } from '../app-configuration-file.ts';
import { type AppConverge, loadAppConverge } from '../app-converge.ts';
import type { ConvergeOutcome } from '../converge-in-process.ts';
import { withComposerAdvice } from '../deployment-summary.ts';
import {
  authoringModuleTargets,
  startWatch,
  type WatchHandle,
  watchTargetsFrom,
} from '../dev/watch.ts';
import { type PipelineDeps, type PipelineResult, runPipeline } from '../pipeline.ts';
import { redactDevEvent, redactError, redactThrown, SecretRedaction } from '../redaction.ts';
import { validateEnvironmentName } from '../validate-environment.ts';
import type { DevEvent, DevInput, DevSession, DevStep } from './dev.ts';
import { claimDevEnvironmentName, requireDevEnvironmentName } from './dev-environment-name.ts';
import { withEmulatorRetry } from './emulator-retry.ts';
import {
  convergeReasonsText,
  DEV_ENVIRONMENT,
  type ExtensionId,
  type OperationDeps,
  requireContainerForEnvironment,
  type ServiceEndpoint,
  toStructured,
} from './shared.ts';
import { reportConvergeEvent, stepTracker } from './steps.ts';

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

/** The file's content hash; undefined when it cannot be read, which counts as a change. */
function contentHash(file: string): string | undefined {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

function sameValues(started: PipelineResult, now: PipelineResult): boolean {
  return (
    isDeepStrictEqual(started.configuration, now.configuration) &&
    isDeepStrictEqual(started.secrets, now.secrets)
  );
}

/** The app secrets the graph's `envSecret()`s name, for the local providers. In memory only. */
function namedSecrets(current: PipelineResult): NamedSecrets {
  const named: Record<string, string> = {};
  for (const key of secretsKeys(current.graph)) {
    const text = current.secrets[key];
    if (text !== undefined && text !== '') named[key] = text;
  }
  return named;
}

type FailedConverge = Exclude<ConvergeOutcome, { readonly kind: 'applied' | 'interrupted' }>;

/** The code and text a converge that failed or was refused settles as. */
function convergeFailure(
  outcome: FailedConverge,
  redact: (text: string) => string,
): {
  readonly code: 'DEV.CONVERGE_FAILED' | 'DEV.CONVERGE_RUNNING' | 'DEV.WORKER_THREAD';
  readonly message: string;
  readonly reasons: readonly { readonly tag: string; readonly message: string }[];
} {
  if (outcome.kind === 'refused') {
    return outcome.reason === 'already-running'
      ? {
          code: 'DEV.CONVERGE_RUNNING',
          message: 'Another converge is already running in this process.',
          reasons: [],
        }
      : {
          code: 'DEV.WORKER_THREAD',
          message:
            'dev cannot converge in a worker thread when its cwd is not the process working directory.',
          reasons: [],
        };
  }
  return {
    code: 'DEV.CONVERGE_FAILED',
    message: redact(withComposerAdvice(convergeReasonsText(outcome.reasons))),
    reasons: outcome.reasons.map(({ tag, message }) => ({ tag, message: redact(message) })),
  };
}

const REFUSAL_HELP = {
  'DEV.CONVERGE_RUNNING': {
    why: "A converge sets the process's environment and working directory while Alchemy runs, so two cannot overlap.",
    fix: 'Wait for the other converge to finish, or run dev in its own process.',
  },
  'DEV.WORKER_THREAD': {
    why: 'Alchemy reads `.env` and keeps `.alchemy` in the working directory, and a worker thread cannot change it.',
    fix: "Call dev from the main thread, or with the process's working directory as its cwd.",
  },
} as const;

function thrownOutcome(error: unknown): ConvergeOutcome {
  return {
    kind: 'failed',
    reasons: [
      {
        tag: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

/** Runs the full dev pipeline; resolves to a running session or a structured failure. */
export async function executeDev(
  input: DevInput,
  deps: OperationDeps,
  cwd: string,
): Promise<Result<DevSession, CliStructuredError>> {
  const redaction = new SecretRedaction(process.env);
  try {
    const result = await executeDevInner(input, deps, cwd, redaction);
    return result.ok ? result : notOk(redactError(result.failure, redaction));
  } catch (error) {
    throw redactThrown(error, redaction);
  }
}

async function executeDevInner(
  input: DevInput,
  deps: OperationDeps,
  cwd: string,
  redaction: SecretRedaction,
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
  removeLeftoverAppConfigurationFiles(cwd);

  let pipeline: Awaited<ReturnType<typeof runPipeline>>;
  let resolved: ReadonlyMap<string, LocalTargetDescriptor>;
  let appConverge: AppConverge;
  // The app definition files: every app file the entry import loaded, and
  // each service's authoring module, hashed as they were when it loaded.
  let startedDefinitions: ReadonlyMap<string, string | undefined>;
  const containers = new Map<ExtensionId, ContainerInstance>();
  const preflightPayloads = new Map<ExtensionId, string>();
  // Each participating extension's view of the running app, made before the
  // first converge so a target that cannot run a dev server fails first.
  const attachmentsById = new Map<ExtensionId, LocalTargetAttachment>();

  // A host onEvent that throws is the host's bug, but it must not kill the
  // session's own control flow — above all it must never prevent `closed`
  // from settling, and a throw inside the fire-and-forget watch callback
  // would be an unhandled rejection killing the process.
  const emit = (event: DevEvent): void => {
    try {
      onEvent?.(redactDevEvent(event, redaction));
    } catch {
      // Swallowed: rendering is the host's; its failures are not the session's.
    }
  };

  try {
    validateEnvironmentName(environment);
    // The shared prefix (pipeline.ts): entry load, Load, registry coverage,
    // name resolution, assemble.
    const pipelineDeps: PipelineDeps = {
      runAssembler: deps.runAssembler,
      devServers: true,
      readSecrets: true,
      redaction,
    };
    pipeline = await runPipeline(
      input.entry,
      input.name,
      environment,
      cwd,
      input.config,
      pipelineDeps,
    );
    const { graph, name } = pipeline;
    const config = pipeline.configSource.value;
    startedDefinitions = new Map(
      [
        ...pipeline.entryModule.files,
        ...authoringModuleTargets(pipeline.entryModule.path, graph).flatMap(
          (target) => target.paths,
        ),
      ].map((file) => [file, contentHash(file)]),
    );

    // Lowering and Alchemy run from the app's own install, found before
    // anything local is created.
    appConverge =
      deps.converge ?? (await loadAppConverge(path.dirname(pipeline.configSource.file)));

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

    requireDevEnvironmentName(devDir, environment);

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
        const payload = await dev.preflight({
          graph,
          container: containers.get(id),
          environment,
          configuration: pipeline.configuration,
          secrets: pipeline.secrets,
          warn: (message) => emit({ kind: 'target-warning', message }),
        });
        if (payload !== undefined) preflightPayloads.set(id, payload);
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

  const config = pipeline.configSource.value;
  const redact = (text: string): string => redaction.redact(text);
  const steps = stepTracker<DevStep>(
    (step) => (step.name === 'converge' ? step.id : `${step.converge}:${step.fqn}`),
    emit,
  );

  /**
   * Lowers `current` against the local target and plans and applies it in
   * this process, as the step `id`. The plan's scope, and the state lease it
   * holds, close before this returns, and so does every step it opened.
   */
  const converge = async (
    current: PipelineResult,
    signal: AbortSignal | undefined,
    id: string,
  ): Promise<ConvergeOutcome> => {
    try {
      claimDevEnvironmentName(devDir, environment);
    } catch (error) {
      throw toStructured('DEV.ENVIRONMENT_WRITE_FAILED', error);
    }
    const root = current.graph.root.node;
    if (root.kind !== 'module') {
      throw new InternalError('runPipeline admitted a root that is not a module');
    }
    steps.start({ name: 'converge', id });
    const outcome = await lowerAndConverge(current, root, signal, id);
    steps.closeOpen(outcome.kind === 'applied' ? 'ok' : 'failed');
    return outcome;
  };

  const lowerAndConverge = async (
    current: PipelineResult,
    root: ModuleNode,
    signal: AbortSignal | undefined,
    id: string,
  ): Promise<ConvergeOutcome> => {
    try {
      const stack = appConverge.lower(root, config, {
        name: current.name,
        environment,
        appConfigurationRead: current.graph.appConfigurationRead,
        bundles: current.assembled.bundles,
        unassembled: Object.keys(current.assembled.devServers),
        containers,
        preflight: preflightPayloads,
        providers: appConverge.localTargetProviders(
          resolved,
          containers,
          devDir,
          current.graph.appConfigurationRead.configurationKeyText,
          namedSecrets(current),
        ),
        state: appConverge.devState(),
      });
      return await appConverge.converge({
        operation: 'deploy',
        stack,
        stage: environment,
        cwd,
        env: {},
        signal,
        onEvent: (event) =>
          reportConvergeEvent(
            steps,
            event,
            redact,
            (resource): DevStep => ({
              name: 'apply-resource',
              converge: id,
              ...resource,
            }),
          ),
      });
    } catch (error) {
      return thrownOutcome(error);
    }
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
        ({ restarted } = await withEmulatorRetry(() =>
          serve({
            address,
            node,
            server,
            configuration: pipeline.configuration,
            secrets: pipeline.secrets,
          }),
        ));
      } catch (error) {
        throw toStructured('DEV.SERVICE_START_FAILED', error);
      }
      if (restarted) onRestarted?.(address, server);
    }
  };

  // Inside the try: a stray `.prisma-composer` FILE must come back as a
  // failure result, not a rejection out of dev().
  let first: ConvergeOutcome;
  try {
    first = await converge(pipeline, input.signal, 'dev.converge');
  } catch (error) {
    await stopStartedServices();
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
  if (first.kind === 'interrupted') {
    await stopStartedServices();
    return notOk(
      new CliStructuredError('DEV.INTERRUPTED', 'dev was interrupted while it converged.', {
        why: 'It stopped while Alchemy planned or applied the app. Resources it had already changed stay as they are.',
        fix: 'Run dev again to finish.',
      }),
    );
  }
  if (first.kind !== 'applied') {
    await stopStartedServices();
    const failure = convergeFailure(first, redact);
    return notOk(
      failure.code === 'DEV.CONVERGE_FAILED'
        ? new CliStructuredError(
            failure.code,
            `The app could not be converged.\n${failure.message}`,
            { meta: { reasons: failure.reasons } },
          )
        : new CliStructuredError(failure.code, failure.message, REFUSAL_HELP[failure.code]),
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
  // Interrupts a rebuild's converge when the session stops.
  const stopController = new AbortController();
  const convergeSignal =
    input.signal === undefined
      ? stopController.signal
      : AbortSignal.any([input.signal, stopController.signal]);
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
    // The app definition files are watched too: the app was imported once, in
    // this process, so an edit to one cannot reach the converge, and the
    // session reports it and pauses instead (ADR-0064).
    const bundleWatch = watchTargetsFrom(pipeline.assembled.bundles);
    const definitionFiles = [...startedDefinitions.keys()];
    const targets = [
      ...bundleWatch.targets,
      ...definitionFiles.map((file) => ({ address: pipeline.graph.root.id, paths: [file] })),
    ];
    for (const address of bundleWatch.unwatchable) {
      emit({ kind: 'unwatchable', address });
    }

    let stopping = false;
    let rebuilds = 0;
    let converging: Promise<ConvergeOutcome> | undefined;
    const watchDeps: PipelineDeps = {
      runAssembler: deps.runAssembler,
      devServers: true,
      readSecrets: true,
      redaction,
    };
    const watchFiles = deps.watch ?? startWatch;
    const onWatchError = (error: unknown): void =>
      emit({ kind: 'watch-error', message: failureMessage(error) });
    const configFile = pipeline.configSource.file;
    const startedConfig = contentHash(configFile);
    let configChanged = false;
    let valuesChanged = false;
    let definitionChanged = false;
    // Read on every event, not only from the config watcher: a build watch
    // on a directory that contains the file can fire first.
    const paused = (): boolean => {
      if (valuesChanged || definitionChanged) return true;
      if (configChanged || contentHash(configFile) !== startedConfig) {
        configChanged = true;
        emit({ kind: 'config-changed', file: configFile });
        return true;
      }
      const changed = definitionFiles.filter(
        (file) => contentHash(file) !== startedDefinitions.get(file),
      );
      if (changed.length === 0) return false;
      definitionChanged = true;
      emit({ kind: 'definition-changed', files: changed });
      return true;
    };
    configWatch = watchFiles(
      [{ address: configFile, paths: [configFile] }],
      () => void paused(),
      onWatchError,
    );
    // The whole rebuild is inside one try/catch: it runs fire-and-forget, so
    // anything escaping it would be an unhandled rejection killing the
    // process — the exact opposite of "a converge failure keeps the running
    // app and keeps watching".
    const rebuild = async (): Promise<void> => {
      try {
        const rePipeline = await runPipeline(
          input.entry,
          input.name,
          environment,
          cwd,
          input.config,
          watchDeps,
        );
        if (stopping) return;
        if (!sameValues(pipeline, rePipeline)) {
          if (!valuesChanged) emit({ kind: 'values-changed' });
          valuesChanged = true;
          return;
        }
        rebuilds += 1;
        converging = converge(rePipeline, convergeSignal, `dev.rebuild.${String(rebuilds)}`);
        const outcome = await converging.finally(() => {
          converging = undefined;
        });
        if (outcome.kind === 'interrupted') return;
        if (outcome.kind !== 'applied') {
          emit({ kind: 'converge-failed', ...convergeFailure(outcome, redact) });
          return;
        }
        if (stopping) return;
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
    // directory, which the previous rebuild's converge may still be reading,
    // and one process runs one converge at a time. Changes during a rebuild
    // coalesce into one more after it.
    let rebuilding: Promise<void> | undefined;
    let changedDuringRebuild = false;
    const rebuildUntilSettled = async (): Promise<void> => {
      do {
        changedDuringRebuild = false;
        await rebuild();
      } while (changedDuringRebuild && !stopping && !paused());
      rebuilding = undefined;
    };
    watch = watchFiles(
      targets,
      () => {
        if (stopping || paused()) return;
        if (rebuilding !== undefined) {
          changedDuringRebuild = true;
          return;
        }
        rebuilding = rebuildUntilSettled();
      },
      onWatchError,
    );
    // A rebuild finishing before the OS-level watches attach would otherwise
    // be missed entirely — wait until watching is real before handing over.
    const startedWatch = watch;
    const startedConfigWatch = configWatch;
    await Promise.all([watch.ready, configWatch.ready]);

    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const stop = (): Promise<void> => {
      if (!stopping) {
        stopping = true;
        emit({ kind: 'stopping' });
        stopController.abort();
        following.abort();
        startedWatch.stop();
        startedConfigWatch.stop();
        void (async () => {
          // A converge still running is interrupted above; its scope closes,
          // releasing the state lease, before the services stop. A rebuild
          // still in its pipeline returns before it converges.
          await converging?.catch(() => undefined);
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
