/**
 * The deploy/destroy executor — main.ts's pipeline orchestration with argv,
 * console, and exit codes removed: typed inputs in, structured results out.
 * Reached only by lazy import from deploy.ts/destroy.ts — this module's
 * static graph transitively loads alchemy's provider tree, so the control
 * entry must never import it statically.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ContainerCredentials,
  ContainerInstance,
  ReporterDescriptor,
  RunReporter,
} from '@internal/core/config';
import { containerEnv, preflightEnv } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, okVoid, type Result } from '@internal/foundation/result';
import {
  DEPLOYMENT_RESULT_FILE_ENV,
  type DeploymentSummary,
  readDeploymentSummary,
} from '../deployment-summary.ts';
import { GENERATED_STACK_RELATIVE_PATH, writeStackFile } from '../generate-stack.ts';
import { type PipelineDeps, type PipelineResult, runPipeline } from '../pipeline.ts';
import { type AlchemyOutcome, alchemyInvocation, spawnAlchemy } from '../run-alchemy.ts';
import {
  RUN_REPORT_FILE_ENV,
  resolveRunReportPath,
  toRunReport,
  writeRunReport,
} from '../run-report.ts';
import { validateStageName } from '../validate-stage.ts';
import type { DeployInput, DeploySuccess } from './deploy.ts';
import type { DestroyEvent, DestroyInput } from './destroy.ts';
import { type ExtensionId, type OperationDeps, toStructured } from './shared.ts';

const ALCHEMY_STATE_DIR = '.alchemy';

/** Destroy guardrail (moved from main.ts): true when `<cwd>/.alchemy` is missing or empty — likely wrong directory or nothing deployed yet. */
function hasNoLocalDeployState(cwd: string): boolean {
  const stateDir = path.join(cwd, ALCHEMY_STATE_DIR);
  return !(fs.existsSync(stateDir) && fs.readdirSync(stateDir).length > 0);
}

interface StackPipelineOptions {
  readonly entry: string;
  readonly name: string | undefined;
  readonly stage: string | undefined;
  readonly cwd: string;
  readonly onEvent: ((event: DestroyEvent) => void) | undefined;
  readonly deps: OperationDeps;
  /** Deploy only: an existing report record to join, from `--build-id`. */
  readonly reportId: string | undefined;
}

export async function executeDeploy(
  input: DeployInput,
  deps: OperationDeps,
  cwd: string,
): Promise<Result<DeploySuccess, CliStructuredError>> {
  const outcome = await runStackPipeline('deploy', {
    entry: input.entry,
    name: input.name,
    stage: input.stage,
    cwd,
    onEvent: undefined,
    deps,
    reportId: input.reportId,
  });

  const reportPath = resolveRunReportPath(input.reportPath, process.env[RUN_REPORT_FILE_ENV], cwd);
  if (reportPath !== undefined) {
    writeRunReport(
      reportPath,
      toRunReport({
        summary: outcome.ok ? outcome.value : undefined,
        stage: input.stage,
        failure: outcome.ok
          ? undefined
          : { code: outcome.failure.code, message: outcome.failure.message },
      }),
    );
  }

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
    name: input.name,
    stage: input.target.kind === 'stage' ? input.target.stage : undefined,
    cwd,
    onEvent: input.onEvent,
    deps,
    reportId: undefined,
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
    readonly stage: string | undefined;
    readonly cwd: string;
    readonly reportId: string | undefined;
    readonly credentials: ContainerCredentials | undefined;
  },
): Promise<readonly ExtensionReporter[]> {
  const opened = await Promise.all(
    extensions.map(async (extension) => {
      if (extension.reporter === undefined) return undefined;
      try {
        const reporter = await extension.reporter.begin(context);
        return reporter === undefined ? undefined : { extensionId: extension.id, reporter };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`\nCould not start deploy reporting for ${extension.id}: ${detail}`);
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
): Promise<void> {
  await Promise.all(
    reporters.map(async ({ extensionId, reporter }) => {
      try {
        await reporter.attach({ container: containers.get(extensionId) });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`\nCould not attach this deploy to its project for ${extensionId}: ${detail}`);
      }
    }),
  );
}

/** Every session's contribution to the alchemy child's environment, so reporting that happens inside the apply can find the run. */
function reporterChildEnv(reporters: readonly ExtensionReporter[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { extensionId, reporter } of reporters) {
    try {
      Object.assign(env, reporter.childEnv());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `\nCould not pass deploy reporting into the apply for ${extensionId}: ${detail}`,
      );
    }
  }
  return env;
}

/** `failingStep` is capped at 500 by the platform and `errorMessage` at 5000; truncating here keeps a long message from costing the whole report. */
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** An interrupted converge (the engine settled a Ctrl-C) — reported as `cancelled`, never as `failed`. */
function wasInterrupted(failure: CliStructuredError): boolean {
  return typeof failure.meta?.['signal'] === 'string';
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
        console.warn(`\nCould not report this deploy's outcome: ${detail}`);
      }
    }),
  );
}

/**
 * Owns the reporting sessions around the pipeline: the inner run opens them
 * once it knows which extensions are configured, and this closes them on
 * every exit path — a returned failure, a success, or a thrown defect.
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
    // A defect, not a structured failure — still the end of the run, and the
    // only chance to record that it ended at all.
    await finishReporters(reporters, {
      ok: false,
      cancelled: false,
      code: 'DEPLOY.UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
  );
  return outcome;
}

/** The pipeline both actions share: validate, resolve containers, preflight,
 * write the stack file, run alchemy against it, then the destroy-only
 * teardown/removal suffix. The value is only ever a summary for deploy. */
async function runStackPipelineInner(
  action: 'deploy' | 'destroy',
  opts: StackPipelineOptions,
  reporters: ExtensionReporter[],
): Promise<Result<DeploymentSummary | undefined, CliStructuredError>> {
  const { entry, name, stage, cwd, onEvent, deps } = opts;

  if (stage !== undefined) {
    try {
      validateStageName(stage);
    } catch (error) {
      // validateStageName raises structured errors at origin; anything else
      // escaping it is a bug and must throw (base-type rule 6).
      if (CliStructuredError.is(error)) return notOk(error);
      throw error;
    }
  }

  // Destroy-only guardrail — first, ahead of every other step, so it
  // surfaces even when the rest of the pipeline goes on to fail for an
  // unrelated reason (missing config, missing built output — both common
  // companions of "nothing was ever deployed from here").
  if (action === 'destroy' && hasNoLocalDeployState(cwd)) {
    onEvent?.({ kind: 'no-local-deploy-state', cwd });
  }

  let pipeline: PipelineResult;
  let containers: Map<ExtensionId, ContainerInstance>;
  let alchemyStage: string;
  // What each preflight hands back, on its way to the alchemy child: preflight
  // runs here, in the parent, and the child re-imports the config from scratch,
  // so anything it learned reaches the lowering only through this transport.
  const preflightPayloads = new Map<string, string>();
  let preflightTransportEnv: Record<string, string> = {};

  try {
    // The shared prefix (pipeline.ts): config discovery/load, entry load,
    // Load, registry coverage, name resolution, assemble.
    const pipelineDeps: PipelineDeps = {
      runAssembler: deps.runAssembler,
      config: deps.config,
      configPath: deps.configPath,
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
    pipeline = await runPipeline(entry, name, cwd, pipelineDeps, onAssembleError);
    const { config, graph, name: resolvedName } = pipeline;

    // Open reporting BEFORE containers are resolved: creating them is the
    // step that can leave a project behind with nothing recording why
    // (composer#103), so a session that started afterwards would miss the
    // one failure it most needs to describe.
    if (action === 'deploy') {
      reporters.push(
        ...(await beginReporters(config.extensions, {
          appName: resolvedName,
          stage,
          cwd,
          reportId: opts.reportId,
          credentials: deps.credentials,
        })),
      );
    }

    // Resolve each extension's own container (e.g. Prisma Cloud's Project +
    // named-stage Branch) via its own descriptor — deploy ensures (creates if
    // absent), destroy locates only — after assembly succeeds, so a deploy
    // that cannot assemble never creates anything on any platform.
    containers = new Map<ExtensionId, ContainerInstance>();
    for (const extension of config.extensions) {
      if (extension.container === undefined) continue;
      try {
        if (action === 'deploy') {
          containers.set(
            extension.id,
            await extension.container.ensure({ appName: resolvedName, stage }, deps.credentials),
          );
        } else {
          const instance = await extension.container.locate(
            { appName: resolvedName, stage },
            deps.credentials,
          );
          if (instance === undefined) {
            throw new CliStructuredError(
              'DEPLOY.TARGET_NOT_FOUND',
              `Nothing deployed for ${resolvedName}${stage !== undefined ? `/${stage}` : ''}.`,
              { fix: 'Deploy it first.' },
            );
          }
          containers.set(extension.id, instance);
        }
      } catch (error) {
        throw toStructured('DEPLOY.CONTAINER_FAILED', error);
      }
    }

    // Containers exist now, so each session can attach its run to the
    // Project/Branch its extension resolved.
    await attachReporters(reporters, containers);

    // The Alchemy stage is never left to Alchemy's own default (`dev_$USER`
    // — machine-dependent, the TML-3157 incident): the state-owning extension's
    // container (same selection as core's resolveStateLayer) pins it, else an
    // explicit --stage must.
    const pinnedStage = containers.get(config.state.extension)?.alchemyStage ?? stage;
    if (pinnedStage === undefined) {
      // Reachable only for deploy without --stage, and destroy --production
      // (destroy --stage always has a user stage) — so the remedy can be
      // command-specific without a third branch.
      throw new CliStructuredError(
        'DEPLOY.SCOPE_MISSING',
        'The configured deploy target supplied no deploy scope (its container defines no ' +
          'alchemyStage), so Alchemy has no stage to run under.',
        {
          fix:
            action === 'deploy'
              ? 'Pass --stage <name> to choose the deploy scope explicitly.'
              : 'destroy --production needs a target whose container supplies the production ' +
                'deploy scope.',
        },
      );
    }
    alchemyStage = pinnedStage;

    // Preflight (deploy only): each extension verifies its platform
    // prerequisites — e.g. that every secret env var in the provision manifest
    // exists for the resolved stage (ADR-0029) — BEFORE any stack file is written
    // or Alchemy runs, so a missing secret fails fast with nothing side-effected.
    if (action === 'deploy') {
      for (const extension of config.extensions) {
        if (extension.preflight === undefined) continue;
        try {
          const payload = await extension.preflight({
            graph,
            container: containers.get(extension.id),
            stage,
            credentials: deps.credentials,
          });
          if (payload !== undefined) preflightPayloads.set(extension.id, payload);
        } catch (error) {
          throw toStructured('DEPLOY.PREFLIGHT_FAILED', error);
        }
      }
      // Serialized HERE, not at the alchemy invocation below: a transport
      // collision (two extension ids mapping to one env var) is a preflight
      // failure, and must surface before the stack file is written.
      try {
        preflightTransportEnv = preflightEnv(preflightPayloads);
      } catch (error) {
        throw toStructured('DEPLOY.PREFLIGHT_FAILED', error);
      }
    }
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }

  // Generate .prisma-composer/alchemy.run.ts (tool state lives where you run
  // the tool). Inside the try: a stray `.prisma-composer` FILE, a read-only or
  // full disk, or a permissions problem must come back as a failure result —
  // "failures are values" covers stack generation too, not just the pipeline.
  //
  // The result file's name is unique per run, so a summary is only ever read
  // from THIS child's report hook: concurrent runs sharing a cwd (two stages
  // deployed from one checkout) cannot read or delete each other's file.
  let stackPath: string;
  const resultFilePath = path.join(
    cwd,
    '.prisma-composer',
    `deployment-result-${String(process.pid)}-${randomUUID()}.json`,
  );
  // Every return below funnels through the finally: the child can write the
  // result file via the report hook before a later step fails, so failure
  // paths must remove it too — otherwise each failed run leaves resource
  // ids/URLs on disk and the files accumulate.
  try {
    try {
      stackPath = writeStackFile({
        entryPath: pipeline.entryModule.path,
        cwd,
        configPath: pipeline.configPath,
        name: pipeline.name,
        assembled: pipeline.assembled,
      });
    } catch (error) {
      // Stack-file write I/O is structured here, at the catch that knows
      // which file was being written (base-type rule 6).
      return notOk(toStructured('DEPLOY.STACK_WRITE_FAILED', error));
    }

    const reproduceCommand = `alchemy ${action} ${GENERATED_STACK_RELATIVE_PATH} --yes --stage ${alchemyStage}`;

    // Hand the terminal to alchemy against the generated file.
    let outcome: AlchemyOutcome;
    try {
      outcome = await (deps.alchemy ?? spawnAlchemy)(
        alchemyInvocation({
          command: action,
          stackFileRelativePath: GENERATED_STACK_RELATIVE_PATH,
          cwd,
          stage: alchemyStage,
          containerEnv: containerEnv(containers),
          preflightEnv: preflightTransportEnv,
          env: {
            ...reporterChildEnv(reporters),
            [DEPLOYMENT_RESULT_FILE_ENV]: resultFilePath,
          },
        }),
      );
    } catch (error) {
      if (CliStructuredError.is(error)) return notOk(error);
      return notOk(
        new CliStructuredError(
          'DEPLOY.ENGINE_FAILED',
          error instanceof Error ? error.message : String(error),
          {
            cause: error,
            meta: {
              diagnostics: { exitCode: undefined, stackFilePath: stackPath, reproduceCommand, cwd },
            },
          },
        ),
      );
    }

    // A signal-killed converge is the user interrupting, not a deploy that
    // went wrong: it is still reported as a failure VALUE (the operation
    // promised a Result), but it carries the signal instead of an exit code
    // so a caller can tell the two apart. The CLI's handler never reaches
    // this branch — it holds the child result itself and settles the abort
    // before reading the failure.
    if (outcome.signal !== null) {
      return notOk(
        new CliStructuredError(
          'DEPLOY.ENGINE_FAILED',
          `alchemy ${action} was interrupted by ${outcome.signal}.`,
          {
            meta: {
              signal: outcome.signal,
              diagnostics: {
                exitCode: undefined,
                signal: outcome.signal,
                stackFilePath: stackPath,
                reproduceCommand,
                cwd,
              },
            },
          },
        ),
      );
    }

    // An adapter that can say neither how the child exited nor what killed it
    // is never treated as success.
    const status = outcome.exitCode ?? 1;
    if (status !== 0) {
      return notOk(
        new CliStructuredError(
          'DEPLOY.ENGINE_FAILED',
          `alchemy ${action} exited with status ${status}.`,
          {
            meta: {
              exitCode: status,
              diagnostics: { exitCode: status, stackFilePath: stackPath, reproduceCommand, cwd },
            },
          },
        ),
      );
    }

    try {
      // Teardown (destroy only): each extension removes infrastructure it
      // owns outside the stack — the destroy above may still have been reading
      // it, and the containers below may refuse to go while it exists. What that
      // infrastructure is, and whether losing it should fail the command, is the
      // extension's business, not this module's.
      if (action === 'destroy') {
        for (const extension of pipeline.config.extensions) {
          if (extension.teardown === undefined) continue;
          try {
            await extension.teardown({ container: containers.get(extension.id), stage });
          } catch (error) {
            throw toStructured('DEPLOY.TEARDOWN_FAILED', error);
          }
        }

        // Container removal (destroy only, after every teardown): the CLI's
        // two-loop order — all teardowns, then all removes — is what structurally
        // preserves ADR-0034's guarantee that a stage's state database is deleted
        // before its Branch (a Branch with an attached database refuses deletion).
        for (const extension of pipeline.config.extensions) {
          if (extension.container === undefined) continue;
          const instance = containers.get(extension.id);
          if (instance === undefined) continue;
          try {
            await extension.container.remove(instance, deps.credentials);
          } catch (error) {
            throw toStructured('DEPLOY.CONTAINER_REMOVE_FAILED', error);
          }
        }
      }
    } catch (error) {
      if (CliStructuredError.is(error)) return notOk(error);
      throw error;
    }

    if (action === 'deploy') {
      return ok(readDeploymentSummary(resultFilePath));
    }
    return ok(undefined);
  } finally {
    try {
      fs.rmSync(resultFilePath, { force: true });
    } catch {
      // Best-effort cleanup — never masks the result it wraps.
    }
  }
}
