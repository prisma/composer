/**
 * The deploy/destroy executor — main.ts's pipeline orchestration with argv,
 * console, and exit codes removed: typed inputs in, structured results out.
 * Reached only by lazy import from deploy.ts/destroy.ts — this module's
 * static graph transitively loads alchemy's provider tree, so the control
 * entry must never import it statically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Graph } from '@internal/core';
import type {
  CallerCredentials,
  ContainerInstance,
  PlatformVariableCheck,
  PreflightFindings,
  ReporterDescriptor,
  RunReporter,
  UnsetPlatformVariable,
} from '@internal/core/config';
import { type DeploymentResult, nodeAddresses } from '@internal/core/deploy';
import { CliStructuredError, InternalError } from '@internal/foundation/errors';
import { notOk, ok, okVoid, type Result } from '@internal/foundation/result';
import { type AppConvergeEntry, loadAppConvergeEntry } from '../app-converge.ts';
import type { ComposerConfigSource } from '../composer-config.ts';
import type { ConvergeOutcome, LoweredStack } from '../converge-in-process.ts';
import {
  capFailureCause,
  type DeploymentSummary,
  toDeploymentSummary,
  withComposerAdvice,
} from '../deployment-summary.ts';
import { type PipelineDeps, type PipelineResult, runPipeline } from '../pipeline.ts';
import {
  credentialLookingValues,
  redactError,
  redactSummary,
  redactThrown,
  redactUnsetPlatformVariable,
  SecretRedaction,
} from '../redaction.ts';
import {
  RUN_REPORT_FILE_ENV,
  resolveRunReportPath,
  toRunReport,
  writeRunReport,
} from '../run-report.ts';
import { refuseSecretsInRootInput } from '../secret-as-plain-value.ts';
import { validateEnvironmentName } from '../validate-environment.ts';
import {
  DEFAULT_DEPLOY_ENVIRONMENT,
  type DeployEvent,
  type DeployInput,
  type DeployStep,
  type DeploySuccess,
} from './deploy.ts';
import type { DestroyEvent, DestroyInput, NoLocalDeployStateEvent } from './destroy.ts';
import {
  convergeReasonsText,
  type ExtensionId,
  type OperationDeps,
  requireContainerForEnvironment,
  toStructured,
} from './shared.ts';
import { interactionMessages, reportConvergeEvent, stepTracker } from './steps.ts';

type PreflightFindingsEvent = Extract<DeployEvent, { readonly kind: 'preflight-findings' }>;
type StackEvent = DeployEvent | DestroyEvent;

const ALCHEMY_STATE_DIR = '.alchemy';

/** Destroy guardrail (moved from main.ts): true when `<cwd>/.alchemy` is missing or empty — likely wrong directory or nothing deployed yet. */
function hasNoLocalDeployState(cwd: string): boolean {
  const stateDir = path.join(cwd, ALCHEMY_STATE_DIR);
  return !(fs.existsSync(stateDir) && fs.readdirSync(stateDir).length > 0);
}

/** Times each step for the host's `onEvent`. A step still open when the run fails is closed as failed, innermost first. */
function stackSteps(onEvent: (event: StackEvent) => void) {
  return stepTracker<DeployStep, PreflightFindingsEvent | NoLocalDeployStateEvent>(
    (step) =>
      step.name === 'assemble-service'
        ? `${step.name}:${step.address}`
        : step.name === 'apply-resource'
          ? `${step.name}:${step.resourceId}`
          : step.name,
    onEvent,
  );
}

type StackSteps = ReturnType<typeof stackSteps>;

interface StackPipelineOptions {
  readonly entry: string | undefined;
  readonly config: ComposerConfigSource;
  readonly name: string | undefined;
  readonly environment: string;
  readonly cwd: string;
  readonly deps: OperationDeps;
  /** Deploy only: an existing report record to join, from `--build-id`. */
  readonly reportId: string | undefined;
  /** Deploy only: where to write the run report, already resolved. */
  readonly reportPath: string | undefined;
  readonly steps: StackSteps;
  /** Interrupts the plan or apply. */
  readonly signal: AbortSignal | undefined;
  readonly redaction: SecretRedaction;
}

export async function executeDeploy(
  input: DeployInput,
  deps: OperationDeps,
  cwd: string,
): Promise<Result<Omit<DeploySuccess, 'durationMs'>, CliStructuredError>> {
  const outcome = await runStackPipeline('deploy', {
    entry: input.entry,
    config: input.config,
    name: input.name,
    environment: input.environment ?? DEFAULT_DEPLOY_ENVIRONMENT,
    cwd,
    deps,
    reportId: input.reportId,
    reportPath: resolveRunReportPath(input.reportPath, process.env[RUN_REPORT_FILE_ENV], cwd),
    steps: stackSteps((event) => {
      if (event.kind !== 'no-local-deploy-state') input.onEvent?.(event);
    }),
    signal: input.signal,
    redaction: deps.redaction ?? new SecretRedaction(process.env),
  });
  if (!outcome.ok) return outcome;
  return ok({ summary: outcome.value });
}

export async function executeDestroy(
  input: DestroyInput,
  deps: OperationDeps,
  cwd: string,
): Promise<Result<void, CliStructuredError>> {
  const outcome = await runStackPipeline('destroy', {
    entry: input.entry,
    config: input.config,
    name: input.name,
    environment: input.environment,
    cwd,
    deps,
    reportId: undefined,
    reportPath: undefined,
    steps: stackSteps((event) => {
      if (event.kind !== 'preflight-findings') input.onEvent?.(event);
    }),
    signal: input.signal,
    redaction: deps.redaction ?? new SecretRedaction(process.env),
  });
  if (!outcome.ok) return outcome;
  return okVoid();
}

/** A live reporting session, kept beside the extension that owns it so `attach` can hand back that extension's own container. */
interface ExtensionReporter {
  readonly extensionId: ExtensionId;
  readonly reporter: RunReporter;
}

/**
 * Opens a session per extension that declares a reporter. A `begin` that
 * throws costs that extension its reporting and nothing else — the deploy
 * has not started, and refusing to run it because an observer failed would
 * invert the relationship.
 */
async function beginReporters(
  extensions: readonly { readonly id: ExtensionId; readonly reporter?: ReporterDescriptor }[],
  context: {
    readonly appName: string;
    readonly graph: Graph;
    readonly environment: string;
    readonly cwd: string;
    readonly reportId: string | undefined;
    readonly credentials: CallerCredentials | undefined;
  },
  redaction: SecretRedaction,
): Promise<readonly ExtensionReporter[]> {
  const opened = await Promise.all(
    extensions.map(async (extension) => {
      if (extension.reporter === undefined) return undefined;
      try {
        const reporter = await extension.reporter.begin(context);
        return reporter === undefined ? undefined : { extensionId: extension.id, reporter };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `\nCould not start deploy reporting for ${extension.id}: ${redaction.redact(detail)}`,
        );
        return undefined;
      }
    }),
  );
  return opened.filter((entry) => entry !== undefined);
}

/** Hands each session its own extension's resolved container, so it can attach the run to what that container names. */
async function attachReporters(
  reporters: readonly ExtensionReporter[],
  containers: ReadonlyMap<ExtensionId, ContainerInstance>,
  redaction: SecretRedaction,
): Promise<void> {
  await Promise.all(
    reporters.map(async ({ extensionId, reporter }) => {
      try {
        await reporter.attach({ container: containers.get(extensionId) });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `\nCould not attach this deploy to its project for ${extensionId}: ${redaction.redact(detail)}`,
        );
      }
    }),
  );
}

/** Every session's contribution to the apply's environment, so reporting that happens inside the apply can find the run. */
function reporterEnv(
  reporters: readonly ExtensionReporter[],
  redaction: SecretRedaction,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { extensionId, reporter } of reporters) {
    try {
      Object.assign(env, reporter.childEnv());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `\nCould not pass deploy reporting into the apply for ${extensionId}: ${redaction.redact(detail)}`,
      );
    }
  }
  return env;
}

/** `failingStep` is capped at 500 by the platform and `errorMessage` at 5000; truncating here keeps a long message from costing the whole report. */
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** An interrupted converge — reported as `cancelled`, never as `failed`. */
function wasInterrupted(failure: CliStructuredError): boolean {
  return failure.code === 'DEPLOY.INTERRUPTED';
}

/**
 * Ends every reporting session, whatever the run did. Sessions never reject
 * by contract, but a buggy one must not turn a converged deploy into a
 * failure — so this swallows anyway, and reports each session independently
 * so one bad implementation cannot silence another.
 */
async function finishReporters(
  reporters: readonly ExtensionReporter[],
  outcome: {
    readonly ok: boolean;
    readonly cancelled: boolean;
    readonly code?: string;
    readonly message?: string;
    readonly summary?: DeploymentSummary | undefined;
  },
  redaction: SecretRedaction,
): Promise<void> {
  // Flattened, not per node: a reporter reads the kinds its own extension
  // emits, and which node produced one is the CLI's presentation concern.
  const entities = outcome.summary?.nodes.flatMap((node) => node.entities) ?? [];
  await Promise.all(
    reporters.map(async ({ reporter }) => {
      try {
        await reporter.finish({
          ok: outcome.ok,
          cancelled: outcome.cancelled,
          failingStep: outcome.code === undefined ? undefined : truncate(outcome.code, 500),
          errorMessage: outcome.message === undefined ? undefined : truncate(outcome.message, 5000),
          entities,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`\nCould not report this deploy's outcome: ${redaction.redact(detail)}`);
      }
    }),
  );
}

/**
 * Owns the reporting sessions around the pipeline: the inner run opens them
 * once it knows which extensions are configured, and this closes them on
 * every exit path — a returned failure, a success, or a thrown defect — as
 * the `record` step, which also writes the run report.
 * Nothing here can change what the pipeline returns.
 */
async function runStackPipeline(
  action: 'deploy' | 'destroy',
  opts: StackPipelineOptions,
): Promise<Result<DeploymentSummary | undefined, CliStructuredError>> {
  const reporters: ExtensionReporter[] = [];
  let outcome: Result<DeploymentSummary | undefined, CliStructuredError>;
  try {
    outcome = await runStackPipelineInner(action, opts, reporters);
  } catch (error) {
    opts.steps.closeOpen('failed');
    opts.steps.start({ name: 'record' });
    const thrown = redactThrown(error, opts.redaction);
    // A defect, not a structured failure — still the end of the run, and the
    // only chance to record that it ended at all.
    await finishReporters(
      reporters,
      {
        ok: false,
        cancelled: false,
        code: 'DEPLOY.UNEXPECTED',
        message: thrown.message,
      },
      opts.redaction,
    );
    opts.steps.finish({ name: 'record' });
    throw thrown;
  }
  if (!outcome.ok) outcome = notOk(redactError(outcome.failure, opts.redaction));
  if (!outcome.ok) opts.steps.closeOpen('failed');
  opts.steps.start({ name: 'record' });
  await finishReporters(
    reporters,
    outcome.ok
      ? { ok: true, cancelled: false, summary: outcome.value }
      : {
          ok: false,
          cancelled: wasInterrupted(outcome.failure),
          code: outcome.failure.code,
          message: outcome.failure.message,
        },
    opts.redaction,
  );
  // Best-effort: an unwritable report fails the step, never the deploy.
  const reportWritten =
    opts.reportPath === undefined ||
    writeRunReport(
      opts.reportPath,
      toRunReport({
        summary: outcome.ok ? outcome.value : undefined,
        environment: opts.environment,
        failure: outcome.ok
          ? undefined
          : { code: outcome.failure.code, message: outcome.failure.message },
      }),
    );
  if (reportWritten) opts.steps.finish({ name: 'record' });
  else opts.steps.fail({ name: 'record' });
  return outcome;
}

/** The pipeline both actions share: validate, load, assemble, resolve
 * containers, then the in-process converge; deploy runs its preflight before
 * the converge, and destroy its teardowns and container removals after it.
 * The value is only ever a summary for deploy. */
async function runStackPipelineInner(
  action: 'deploy' | 'destroy',
  opts: StackPipelineOptions,
  reporters: ExtensionReporter[],
): Promise<Result<DeploymentSummary | undefined, CliStructuredError>> {
  const { entry, config: composerConfig, name, environment, cwd, deps, steps } = opts;

  steps.start({ name: 'prepare' });
  try {
    validateEnvironmentName(environment);
  } catch (error) {
    // validateEnvironmentName raises structured errors at origin; anything else
    // escaping it is a bug and must throw (base-type rule 6).
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }

  // Destroy-only guardrail — ahead of every other step, so it surfaces even
  // when the rest of the pipeline goes on to fail for an unrelated reason
  // (missing config, missing built output — both common companions of
  // "nothing was ever deployed from here").
  if (action === 'destroy' && hasNoLocalDeployState(cwd)) {
    steps.emit({ kind: 'no-local-deploy-state', cwd });
  }

  const loaded = await prepareAppConvergeEntry(
    deps,
    path.dirname(path.resolve(cwd, composerConfig.file)),
  );
  if (!loaded.ok) return loaded;
  const appConvergeEntry = loaded.value;
  const platformCredentials = deps.credentials;

  let pipeline: PipelineResult;
  let containers: Map<ExtensionId, ContainerInstance>;
  let alchemyStage: string;
  // What each deploy preflight hands back, for the lowering.
  const preflightPayloads = new Map<string, string>();
  const unset: UnsetPlatformVariable[] = [];

  try {
    // The shared prefix (pipeline.ts): entry load, Load, registry coverage,
    // name resolution, assemble.
    const pipelineDeps: PipelineDeps = {
      runAssembler: deps.runAssembler,
      readSecrets: action === 'deploy',
      redaction: opts.redaction,
      onEvent: (event) => {
        switch (event.kind) {
          case 'loaded':
            steps.finish({ name: 'prepare' });
            steps.start({ name: 'assemble' });
            return;
          case 'service-started':
            steps.start({ name: 'assemble-service', address: event.address });
            return;
          case 'service-assembled':
            steps.finish({ name: 'assemble-service', address: event.address }, event.data);
            return;
        }
      },
    };
    const onAssembleError =
      action === 'destroy'
        ? (error: Error): CliStructuredError =>
            new CliStructuredError('DEPLOY.BUILD_REQUIRED', error.message, {
              why:
                'destroy evaluates the same stack program as deploy, which packages ' +
                'the built artifacts — so the app must be built first.',
              fix: 'Run the build, then retry the destroy.',
              cause: error,
            })
        : undefined;
    pipeline = await runPipeline(
      entry,
      name,
      environment,
      cwd,
      composerConfig,
      pipelineDeps,
      onAssembleError,
    );
    steps.finish({ name: 'assemble' });
    const { graph, name: resolvedName } = pipeline;
    const config = pipeline.configSource.value;
    if (action === 'deploy') {
      refuseSecretsInRootInput(
        graph.appConfigurationRead,
        opts.redaction.knownSecrets,
        'A deploy sends every plain value Load read to the platform as plain configuration, and never sends a secret that way.',
      );
    }

    steps.start({ name: 'connect' });
    // Open reporting BEFORE containers are resolved: creating them is the
    // step that can leave a project behind with nothing recording why
    // (composer#103), so a session that started afterwards would miss the
    // one failure it most needs to describe.
    if (action === 'deploy') {
      reporters.push(
        ...(await beginReporters(
          config.extensions,
          {
            appName: resolvedName,
            graph,
            environment,
            cwd,
            reportId: opts.reportId,
            credentials: platformCredentials,
          },
          opts.redaction,
        )),
      );
    }

    // Resolve each extension's own container (e.g. Prisma Cloud's Project +
    // the environment's Branch) via its own descriptor — deploy ensures (creates if
    // absent), destroy locates only — after assembly succeeds, so a deploy
    // that cannot assemble never creates anything on any platform.
    containers = new Map<ExtensionId, ContainerInstance>();
    for (const extension of config.extensions) {
      if (extension.container === undefined) continue;
      try {
        if (action === 'deploy') {
          const instance = await extension.container.ensure(
            { appName: resolvedName, environment },
            platformCredentials,
          );
          requireContainerForEnvironment(
            action,
            extension.id,
            extension.container,
            instance,
            environment,
          );
          containers.set(extension.id, instance);
        } else {
          const instance = await extension.container.locate(
            { appName: resolvedName, environment },
            platformCredentials,
          );
          if (instance === undefined) {
            throw new CliStructuredError(
              'DEPLOY.TARGET_NOT_FOUND',
              `Nothing deployed for ${resolvedName} in the environment ${environment}.`,
              { fix: 'Deploy it first.' },
            );
          }
          requireContainerForEnvironment(
            action,
            extension.id,
            extension.container,
            instance,
            environment,
          );
          containers.set(extension.id, instance);
        }
      } catch (error) {
        throw toStructured('DEPLOY.CONTAINER_FAILED', error);
      }
    }

    // Containers exist now, so each session can attach its run to the
    // Project/Branch its extension resolved.
    await attachReporters(reporters, containers, opts.redaction);

    // The Alchemy stage is never left to Alchemy's own default (`dev_$USER`
    // — machine-dependent, the TML-3157 incident): the state-owning extension's
    // container (same selection as core's resolveStateLayer) pins it, else the
    // environment name does.
    alchemyStage = containers.get(config.state.extension)?.alchemyStage ?? environment;
    steps.finish({ name: 'connect' });

    if (action === 'deploy') {
      steps.start({ name: 'preflight' });
      let checked = 0;
      const report = (reported: PlatformVariableCheck): void => {
        checked += reported.checked;
        unset.push(
          ...reported.unset.map((variable) =>
            redactUnsetPlatformVariable(variable, opts.redaction),
          ),
        );
      };
      for (const extension of config.extensions) {
        if (extension.preflight === undefined) continue;
        try {
          const payload = await extension.preflight({
            graph,
            container: containers.get(extension.id),
            environment,
            configuration: pipeline.configuration,
            secrets: pipeline.secrets,
            credentials: platformCredentials,
            report,
          });
          if (payload !== undefined) preflightPayloads.set(extension.id, payload);
        } catch (error) {
          throw toStructured('DEPLOY.PREFLIGHT_FAILED', error);
        }
      }
      steps.finish({ name: 'preflight' }, { checked, unset: unset.length });
      if (unset.length > 0) steps.emit({ kind: 'preflight-findings', findings: { unset } });
    }
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }

  const converged = await convergeStack(action, opts, pipeline, appConvergeEntry, {
    containers,
    stage: alchemyStage,
    preflightPayloads,
    findings: { unset },
    env: action === 'deploy' ? reporterEnv(reporters, opts.redaction) : {},
  });
  if (action === 'deploy' || !converged.ok) return converged;

  try {
    // Teardown: each extension removes infrastructure it owns outside the
    // stack — the destroy above may still have been reading it, and the
    // containers below may refuse to go while it exists. What that
    // infrastructure is, and whether losing it should fail the command, is the
    // extension's business, not this module's.
    for (const extension of pipeline.configSource.value.extensions) {
      if (extension.teardown === undefined) continue;
      try {
        await extension.teardown({ container: containers.get(extension.id), environment });
      } catch (error) {
        throw toStructured('DEPLOY.TEARDOWN_FAILED', error);
      }
    }

    // Container removal, after every teardown: all teardowns, then all
    // removes, is what preserves ADR-0034's guarantee that an environment's
    // state database is deleted before its Branch (a Branch with an attached
    // database refuses deletion).
    for (const extension of pipeline.configSource.value.extensions) {
      if (extension.container === undefined) continue;
      const instance = containers.get(extension.id);
      if (instance === undefined) continue;
      try {
        await extension.container.remove(instance, platformCredentials);
      } catch (error) {
        throw toStructured('DEPLOY.CONTAINER_REMOVE_FAILED', error);
      }
    }
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
  return ok(undefined);
}

/** Loaded before anything is created, so a missing or incompatible install fails first. */
async function prepareAppConvergeEntry(
  deps: OperationDeps,
  appDir: string,
): Promise<Result<AppConvergeEntry, CliStructuredError>> {
  try {
    return ok(deps.appConvergeEntry ?? (await loadAppConvergeEntry(appDir)));
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}

const WORDS = {
  deploy: { action: 'deploy', Action: 'Deploy', running: 'Another deploy is' },
  destroy: { action: 'destroy', Action: 'Destroy', running: 'Another deploy or destroy is' },
} as const;

/** The structured failure a converge that did not apply settles as. */
function convergeFailure(
  action: 'deploy' | 'destroy',
  outcome: Exclude<ConvergeOutcome, { readonly kind: 'applied' }>,
  redact: (text: string) => string,
): CliStructuredError {
  const words = WORDS[action];
  switch (outcome.kind) {
    case 'interrupted':
      return new CliStructuredError('DEPLOY.INTERRUPTED', `The ${words.action} was interrupted.`, {
        why: 'It stopped while Alchemy planned or applied it. Resources it had already changed stay as they are.',
        fix: `${words.Action} again to finish.`,
      });
    case 'refused':
      return outcome.reason === 'already-running'
        ? new CliStructuredError(
            'DEPLOY.CONVERGE_RUNNING',
            `${words.running} already running in this process.`,
            {
              why: `A ${words.action} sets the process's environment and working directory while Alchemy runs, so two cannot overlap.`,
              fix: `Wait for the other one to finish, or run this ${words.action} in its own process.`,
            },
          )
        : new CliStructuredError(
            'DEPLOY.WORKER_THREAD',
            `${words.Action} cannot run in a worker thread when its cwd is not the process working directory.`,
            {
              why: 'Alchemy reads `.env` and keeps `.alchemy` in the working directory, and a worker thread cannot change it.',
              fix: `Call ${words.action} from the main thread, or with the process's working directory as its cwd.`,
            },
          );
    case 'failed': {
      const cause = capFailureCause(
        redact(withComposerAdvice(convergeReasonsText(outcome.reasons))),
      );
      return new CliStructuredError(
        'DEPLOY.ENGINE_FAILED',
        `Alchemy could not ${words.action} the app.\n${cause}`,
        {
          meta: {
            engineCause: cause,
            reasons: outcome.reasons.map(({ tag, message }) => ({ tag, message: redact(message) })),
          },
        },
      );
    }
  }
  return new CliStructuredError(
    'DEPLOY.ENGINE_FAILED',
    'The converge ended with an outcome this Composer does not know.',
  );
}

/**
 * Lowers the app with the containers and preflight payloads this run
 * resolved, then plans and applies `action` in this process. A deploy's
 * report hook runs inside the apply, here, so its summary comes back as a
 * value.
 */
async function convergeStack(
  action: 'deploy' | 'destroy',
  opts: StackPipelineOptions,
  pipeline: PipelineResult,
  entry: AppConvergeEntry,
  resolved: {
    readonly containers: ReadonlyMap<ExtensionId, ContainerInstance>;
    readonly stage: string;
    readonly preflightPayloads: ReadonlyMap<ExtensionId, string>;
    readonly findings: PreflightFindings;
    readonly env: Readonly<Record<string, string>>;
  },
): Promise<Result<DeploymentSummary | undefined, CliStructuredError>> {
  const { cwd, environment, steps } = opts;
  const config = pipeline.configSource.value;
  const env = resolved.env;
  opts.redaction.addCredentialLookingValues(credentialLookingValues(env));
  const redact = (text: string): string => opts.redaction.redact(text);
  let summary: DeploymentSummary | undefined;
  const report = (result: DeploymentResult): void => {
    summary = toDeploymentSummary(result);
  };

  const root = pipeline.graph.root.node;
  if (root.kind !== 'module')
    throw new InternalError('runPipeline admitted a root that is not a module');

  steps.start({ name: 'apply' });
  let stack: LoweredStack;
  try {
    stack = entry.lower(root, config, {
      name: pipeline.name,
      environment,
      appConfigurationRead: pipeline.graph.appConfigurationRead,
      preparedNodeAddresses: nodeAddresses(pipeline.graph),
      bundles: pipeline.assembled.bundles,
      containers: resolved.containers,
      preflightPayloads: resolved.preflightPayloads,
      findings: resolved.findings,
      credentials: opts.deps.credentials,
      ...(action === 'deploy' ? { report } : {}),
    });
  } catch (error) {
    // An extension's state or providers factory threw while the stack was built.
    if (CliStructuredError.is(error)) return notOk(error);
    return notOk(
      new CliStructuredError(
        'DEPLOY.ENGINE_FAILED',
        redact(error instanceof Error ? error.message : String(error)),
      ),
    );
  }
  const output = interactionMessages(steps, opts.redaction);
  let outcome: ConvergeOutcome;
  try {
    outcome = await entry.converge({
      operation: action,
      stack,
      stage: resolved.stage,
      cwd,
      env,
      signal: opts.signal,
      onEvent: (event) =>
        reportConvergeEvent(
          steps,
          event,
          redact,
          (resource): DeployStep => ({
            name: 'apply-resource',
            ...resource,
          }),
        ),
      output: (text) => output.push(text),
    });
  } catch (error) {
    return notOk(
      new CliStructuredError(
        'DEPLOY.ENGINE_FAILED',
        redact(
          `Alchemy could not ${action} the app.\n${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    );
  } finally {
    output.end();
  }
  if (outcome.kind !== 'applied') return notOk(convergeFailure(action, outcome, redact));
  steps.finish({ name: 'apply' });
  return ok(redactSummary(summary, opts.redaction));
}
