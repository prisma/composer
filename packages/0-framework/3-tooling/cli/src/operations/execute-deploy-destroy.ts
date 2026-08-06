/**
 * The deploy/destroy executor — main.ts's pipeline orchestration (steps 0–9.75)
 * with argv, console, and exit codes removed: typed inputs in, structured
 * results out. Reached only by lazy import from operations.ts — this module's
 * static graph transitively loads alchemy's provider tree, so the control
 * entry must never import it statically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContainerInstance } from '@internal/core/config';
import { containerEnv } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import { CliError } from '../cli-error.ts';
import { GENERATED_STACK_RELATIVE_PATH, writeStackFile } from '../generate-stack.ts';
import { type PipelineDeps, type PipelineResult, runPipeline } from '../pipeline.ts';
import { DEPLOYMENT_RESULT_FILE_ENV, type DeploymentSummary } from '../render-deployment.ts';
import { runAlchemy } from '../run-alchemy.ts';
import { validateStageName } from '../validate-stage.ts';
import type {
  DeployInput,
  DeployResult,
  DestroyEvent,
  DestroyInput,
  DestroyResult,
  OperationDeps,
  OperationFailure,
} from './results.ts';

const ALCHEMY_STATE_DIR = '.alchemy';

/** Destroy guardrail (moved from main.ts): true when `<cwd>/.alchemy` is missing or empty — likely wrong directory or nothing deployed yet. */
function hasNoLocalDeployState(cwd: string): boolean {
  const stateDir = path.join(cwd, ALCHEMY_STATE_DIR);
  return !(fs.existsSync(stateDir) && fs.readdirSync(stateDir).length > 0);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the alchemy child's result file (written by deploymentReport when
 * DEPLOYMENT_RESULT_FILE_ENV is set). Absent or malformed → undefined — the
 * summary is best-effort, never a deploy failure.
 */
export function readDeploymentSummary(resultFilePath: string): DeploymentSummary | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(resultFilePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed['app'] !== 'string' || !Array.isArray(parsed['nodes'])) {
    return undefined;
  }
  for (const node of parsed['nodes']) {
    if (
      !isRecord(node) ||
      typeof node['address'] !== 'string' ||
      !Array.isArray(node['entities'])
    ) {
      return undefined;
    }
    for (const entity of node['entities']) {
      if (
        !isRecord(entity) ||
        typeof entity['kind'] !== 'string' ||
        typeof entity['id'] !== 'string'
      ) {
        return undefined;
      }
    }
  }
  return blindCast<
    DeploymentSummary,
    'the field-by-field checks above validate the runtime shape (string app, nodes with string addresses and kind/id-carrying entities); optional entity fields (url, details) are presentation-only strings the writer serialized from the same type'
  >(parsed);
}

interface ExecuteOptions {
  readonly entry: string;
  readonly name: string | undefined;
  readonly stage: string | undefined;
  readonly cwd: string;
  readonly onEvent: ((event: DestroyEvent) => void) | undefined;
  readonly deps: OperationDeps | undefined;
}

export async function executeDeploy(input: DeployInput, cwd: string): Promise<DeployResult> {
  const outcome = await executeDeployOrDestroy('deploy', {
    entry: input.entry,
    name: input.name,
    stage: input.stage,
    cwd,
    onEvent: undefined,
    deps: input.deps,
  });
  if (outcome.failure !== undefined) return { outcome: 'failed', failure: outcome.failure };
  return { outcome: 'deployed', summary: outcome.summary };
}

export async function executeDestroy(input: DestroyInput, cwd: string): Promise<DestroyResult> {
  const outcome = await executeDeployOrDestroy('destroy', {
    entry: input.entry,
    name: input.name,
    stage: input.target.kind === 'stage' ? input.target.stage : undefined,
    cwd,
    onEvent: input.onEvent,
    deps: input.deps,
  });
  if (outcome.failure !== undefined) return { outcome: 'failed', failure: outcome.failure };
  return { outcome: 'destroyed' };
}

interface ExecuteOutcome {
  readonly failure?: OperationFailure | undefined;
  readonly summary?: DeploymentSummary | undefined;
}

async function executeDeployOrDestroy(
  action: 'deploy' | 'destroy',
  opts: ExecuteOptions,
): Promise<ExecuteOutcome> {
  const { entry, name, stage, cwd, onEvent, deps } = opts;

  if (stage !== undefined) {
    try {
      validateStageName(stage);
    } catch (error) {
      if (error instanceof CliError) {
        return { failure: { kind: 'invalid-input', message: error.message, cause: error } };
      }
      throw error;
    }
  }

  // 0. destroy-only guardrail — first, ahead of every other step, so it
  // surfaces even when the rest of the pipeline goes on to fail for an
  // unrelated reason (missing config, missing built output — both common
  // companions of "nothing was ever deployed from here").
  if (action === 'destroy' && hasNoLocalDeployState(cwd)) {
    onEvent?.({ kind: 'no-local-deploy-state', cwd });
  }

  let pipeline: PipelineResult;
  let containers: Map<string, ContainerInstance>;
  let alchemyStage: string;

  try {
    // 1–6. The shared prefix (pipeline.ts): config discovery/load, entry load,
    // Load, registry coverage, name resolution, assemble.
    const pipelineDeps: PipelineDeps = { runAssembler: deps?.runAssembler, config: deps?.config };
    const onAssembleError =
      action === 'destroy'
        ? (error: Error): CliError =>
            new CliError(
              `${error.message}\n\ndestroy evaluates the same stack program as deploy, which packages ` +
                'the built artifacts — so the app must be built first. Run the build, then retry the destroy.',
            )
        : undefined;
    pipeline = await runPipeline(entry, name, cwd, pipelineDeps, onAssembleError);
    const { config, graph, name: resolvedName } = pipeline;

    // 7. Resolve each extension's own container (e.g. Prisma Cloud's Project +
    // named-stage Branch) via its own descriptor — deploy ensures (creates if
    // absent), destroy locates only — after assembly succeeds, so a deploy
    // that cannot assemble never creates anything on any platform.
    containers = new Map<string, ContainerInstance>();
    for (const extension of config.extensions) {
      if (extension.container === undefined) continue;
      try {
        if (action === 'deploy') {
          containers.set(
            extension.id,
            await extension.container.ensure({ appName: resolvedName, stage }),
          );
        } else {
          const instance = await extension.container.locate({ appName: resolvedName, stage });
          if (instance === undefined) {
            throw new CliError(
              `Nothing deployed for ${resolvedName}${stage !== undefined ? `/${stage}` : ''} — deploy it first.`,
            );
          }
          containers.set(extension.id, instance);
        }
      } catch (error) {
        throw error instanceof CliError
          ? error
          : new CliError(error instanceof Error ? error.message : String(error));
      }
    }

    // 7.3 The Alchemy stage is never left to Alchemy's own default (`dev_$USER`
    // — machine-dependent, the TML-3157 incident): the state-owning extension's
    // container (same selection as core's resolveStateLayer) pins it, else an
    // explicit --stage must.
    const pinnedStage = containers.get(config.state.extension)?.alchemyStage ?? stage;
    if (pinnedStage === undefined) {
      // Reachable only for deploy without --stage, and destroy --production
      // (destroy --stage always has a user stage) — so the remedy can be
      // command-specific without a third branch.
      throw new CliError(
        'The configured deploy target supplied no deploy scope (its container defines no ' +
          'alchemyStage), so Alchemy has no stage to run under. ' +
          (action === 'deploy'
            ? 'Pass --stage <name> to choose the deploy scope explicitly.'
            : 'destroy --production needs a target whose container supplies the production ' +
              'deploy scope.'),
      );
    }
    alchemyStage = pinnedStage;

    // 7.5 Preflight (deploy only): each extension verifies its platform
    // prerequisites — e.g. that every secret env var in the provision manifest
    // exists for the resolved stage (ADR-0029) — BEFORE any stack file is written
    // or Alchemy runs, so a missing secret fails fast with nothing side-effected.
    if (action === 'deploy') {
      for (const extension of config.extensions) {
        if (extension.preflight === undefined) continue;
        try {
          await extension.preflight({ graph, container: containers.get(extension.id), stage });
        } catch (error) {
          throw error instanceof CliError
            ? error
            : new CliError(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } catch (error) {
    return { failure: { kind: 'pipeline', message: failureMessage(error), cause: error } };
  }

  // 8. Generate .prisma-composer/alchemy.run.ts (tool state lives where you run the tool).
  const stackPath = writeStackFile({
    entryPath: pipeline.entryModule.path,
    cwd,
    configPath: pipeline.configPath,
    name: pipeline.name,
    assembled: pipeline.assembled,
  });

  const reproduceCommand = `alchemy ${action} ${GENERATED_STACK_RELATIVE_PATH} --yes --stage ${alchemyStage}`;

  // Stale-result guard: remove any previous run's result file so a summary is
  // only ever read from THIS child's report hook.
  const resultFilePath = path.join(cwd, '.prisma-composer', 'deployment-result.json');
  fs.rmSync(resultFilePath, { force: true });

  // 9. Shell out to alchemy against the generated file.
  let status: number;
  try {
    status = (deps?.alchemy ?? runAlchemy)({
      command: action,
      stackFileRelativePath: GENERATED_STACK_RELATIVE_PATH,
      cwd,
      stage: alchemyStage,
      containerEnv: containerEnv(containers),
      env: { ...process.env, [DEPLOYMENT_RESULT_FILE_ENV]: resultFilePath },
    });
  } catch (error) {
    return {
      failure: {
        kind: 'execution',
        message: failureMessage(error),
        exitCode: undefined,
        stackFilePath: stackPath,
        reproduceCommand,
        cwd,
        cause: error,
      },
    };
  }
  if (status !== 0) {
    return {
      failure: {
        kind: 'execution',
        message: `alchemy ${action} exited with status ${status}.`,
        exitCode: status,
        stackFilePath: stackPath,
        reproduceCommand,
        cwd,
      },
    };
  }

  try {
    // 9.5 Teardown (destroy only): each extension removes infrastructure it
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
          throw error instanceof CliError
            ? error
            : new CliError(error instanceof Error ? error.message : String(error));
        }
      }

      // 9.75 Container removal (destroy only, after every teardown): the CLI's
      // two-loop order — all teardowns, then all removes — is what structurally
      // preserves ADR-0034's guarantee that a stage's state database is deleted
      // before its Branch (a Branch with an attached database refuses deletion).
      for (const extension of pipeline.config.extensions) {
        if (extension.container === undefined) continue;
        const instance = containers.get(extension.id);
        if (instance === undefined) continue;
        try {
          await extension.container.remove(instance);
        } catch (error) {
          throw error instanceof CliError
            ? error
            : new CliError(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } catch (error) {
    return { failure: { kind: 'pipeline', message: failureMessage(error), cause: error } };
  }

  if (action === 'deploy') {
    return { summary: readDeploymentSummary(resultFilePath) };
  }
  return {};
}
