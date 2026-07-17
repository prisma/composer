/**
 * Argument parsing (clipanion — prisma-next's CLI idiom, see
 * prisma-next/packages/1-framework/3-tooling/cli/src/migration-cli.ts) +
 * orchestration of deploy-cli.md § The pipeline.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assembleServices, type RunAssembler } from '@internal/assemble';
import { Load } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import type { ResolvedContainer } from '@internal/lowering';
import { Cli, Command, Option, UsageError } from 'clipanion';
import { CliError } from './cli-error.ts';
import {
  deleteAppProject,
  deleteStageBranch,
  type EnsureContainersInput,
  ensureContainers,
} from './ensure-containers.ts';
import { GENERATED_STACK_RELATIVE_PATH, writeStackFile } from './generate-stack.ts';
import { findConfigPathForEntry, loadAppConfig, missingConfigError } from './load-config.ts';
import { loadEntry } from './load-entry.ts';
import { type RunAlchemyInput, runAlchemy } from './run-alchemy.ts';
import { validateRegistryCoverage } from './validate-coverage.ts';

const BINARY_NAME = 'prisma-composer';

/** The <entry>/--name/--stage surface shared by deploy and destroy; execute() is unused — run() drives the pipeline directly so error handling stays under this module's control. */
abstract class DeployCliCommand extends Command {
  entry = Option.String({ name: 'entry' });

  name = Option.String('--name', {
    description: "Override the root node's name — the deploy's application name.",
  });

  stage = Option.String('--stage', {
    description: 'Alchemy stage to target.',
  });

  production = Option.Boolean('--production', false, {
    description:
      'destroy: tear down the project-level production environment (required to destroy production).',
  });

  abstract readonly action: 'deploy' | 'destroy';

  async execute(): Promise<number> {
    return 0;
  }
}

class DeployCommand extends DeployCliCommand {
  static override paths = [['deploy']];
  static override usage = Command.Usage({
    description: "Deploy the application whose root node is <entry>'s default export.",
    examples: [['Deploy an app', '$0 deploy src/service.ts']],
  });
  readonly action = 'deploy' as const;
}

class DestroyCommand extends DeployCliCommand {
  static override paths = [['destroy']];
  static override usage = Command.Usage({
    description:
      "Tear down the application whose root node is <entry>'s default export — same derivation as deploy, Alchemy destroy.",
    examples: [['Destroy an app', '$0 destroy src/service.ts']],
  });
  readonly action = 'destroy' as const;
}

function buildCli(): Cli {
  return Cli.from([DeployCommand, DestroyCommand], {
    binaryName: BINARY_NAME,
    binaryLabel: 'The prisma-composer deploy CLI',
  });
}

/** Thrown internally when the user explicitly asked for `--help`/`-h` — run() prints it to stdout and exits 0; not a usage error. */
class HelpRequested extends Error {}

/** Duck-typed: clipanion's UnknownSyntaxError isn't re-exported, so match its name + clipanion.type discriminator (mirrors prisma-next's migration-cli.ts). */
function isUnknownSyntaxError(error: unknown): error is Error {
  if (!(error instanceof Error) || error.name !== 'UnknownSyntaxError') return false;
  const meta = (error as { clipanion?: { type?: string } }).clipanion;
  return typeof meta === 'object' && meta !== null && meta.type === 'none';
}

export interface ParsedArgs {
  readonly command: 'deploy' | 'destroy';
  readonly entry: string;
  readonly name: string | undefined;
  readonly stage: string | undefined;
  readonly production: boolean;
}

/** Exported for direct testing (main.test.ts) — not part of the package's public barrel (see index.ts). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const cli = buildCli();

  let command: unknown;
  try {
    command = cli.process([...argv]);
  } catch (error) {
    // Any parse-time failure — unmatched command, missing <entry>, a
    // trailing --name/--stage with no value (F02), an unknown flag — becomes
    // the same usage error clipanion would otherwise print itself.
    if (isUnknownSyntaxError(error) || error instanceof UsageError) {
      throw new UsageError(cli.usage(null, { detailed: true }));
    }
    throw error;
  }

  if (command instanceof DeployCommand || command instanceof DestroyCommand) {
    return {
      command: command.action,
      entry: command.entry,
      name: command.name,
      stage: command.stage,
      production: command.production,
    };
  }

  // Anything else is clipanion's own built-in help fallback (it returns an
  // internal HelpCommand instance rather than throwing) — a bare invocation,
  // an unmatched command that still resembles a request for help, or an
  // explicit --help/-h.
  if (argv.includes('--help') || argv.includes('-h')) {
    throw new HelpRequested(cli.usage(null, { detailed: true }));
  }
  throw new UsageError(cli.usage(null, { detailed: true }));
}

/** Injectable seams so tests can drive run() without a real wrapper build, config evaluation, or alchemy process. */
export interface RunDeps {
  /** Substituted into assembleServices — see @internal/assemble's RunAssembler. */
  readonly runAssembler?: RunAssembler;
  readonly ensureContainers?: (input: EnsureContainersInput) => Promise<ResolvedContainer>;
  readonly alchemy?: (input: RunAlchemyInput) => number;
  readonly deleteBranch?: (input: { branchId: string }) => Promise<void>;
  readonly deleteProject?: (input: { projectId: string }) => Promise<void>;
  /** Substituted for the c12 evaluation of the discovered config file (discovery itself still runs — the generated stack file needs the real path). */
  readonly config?: PrismaAppConfig;
}

/** Destroy must name its target explicitly — no silent default to production (spec §10). */
function effectiveStage(args: ParsedArgs): string | undefined {
  if (args.command === 'deploy') {
    if (args.production) {
      throw new CliError(
        '--production is only valid with `destroy`; `deploy` targets production by default (omit --stage).',
      );
    }
    return args.stage;
  }
  if (args.stage !== undefined && args.production) {
    throw new CliError('Pass either --stage <name> or --production to `destroy`, not both.');
  }
  if (args.stage === undefined && !args.production) {
    throw new CliError(
      '`destroy` requires an explicit target: --stage <name> to tear down a branch ' +
        'environment, or --production to tear down the production environment.',
    );
  }
  return args.production ? undefined : args.stage;
}

const ALCHEMY_STATE_DIR = '.alchemy';

/** Warns (doesn't fail) when destroy finds no local deploy state under cwd — likely wrong directory or nothing deployed yet. */
function warnIfNoLocalDeployState(cwd: string): void {
  const stateDir = path.join(cwd, ALCHEMY_STATE_DIR);
  const hasState = fs.existsSync(stateDir) && fs.readdirSync(stateDir).length > 0;
  if (!hasState) {
    console.warn(
      `\nNo prior deploy state under ${cwd} — if you deployed from a different directory, run ` +
        'destroy from there; otherwise this is a no-op.',
    );
  }
}

/** Runs the full pipeline; returns the process exit code. */
export async function run(argv: readonly string[], deps: RunDeps = {}): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return 0;
    }
    throw error;
  }
  const stage = effectiveStage(args);
  const cwd = process.cwd();

  // 0. destroy-only guardrail — first, ahead of every other step, so it
  // surfaces even when the rest of the pipeline goes on to fail for an
  // unrelated reason (missing config, missing built output — both common
  // companions of "nothing was ever deployed from here").
  if (args.command === 'destroy') {
    warnIfNoLocalDeployState(cwd);
  }

  // 1. Find + load prisma-composer.config.ts — runs extension env validation before the entry import.
  const resolvedEntryPath = path.resolve(cwd, args.entry);
  const configPath = findConfigPathForEntry(resolvedEntryPath);
  if (configPath === undefined) {
    throw missingConfigError(resolvedEntryPath);
  }
  const config = deps.config ?? (await loadAppConfig(configPath)).config;

  // 2. Import the entry module; its default export must be a node.
  const entryModule = await loadEntry(args.entry, cwd);

  // 3. Load — core's LoadError (unwired connection input, etc.) surfaces as-is.
  const graph = Load(entryModule.root);
  if (graph.root.node.kind !== 'module') {
    throw new CliError(
      'The deploy root must be a module — wrap your service, e.g. ' +
        "export default module('name', ({ provision }) => { provision(service); }).",
    );
  }

  // 4. Registry coverage: every node/build in the graph has a matching descriptor in the config.
  validateRegistryCoverage(graph, config);

  // 5. Resolve the name.
  const name = args.name ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliError('The root node has no name — name it at authoring, or pass --name.');
  }

  // 6. Assemble each service through the config's registries.
  let assembled: Awaited<ReturnType<typeof assembleServices>>;
  try {
    assembled = await assembleServices(graph, config, cwd, deps.runAssembler);
  } catch (error) {
    if (args.command === 'destroy' && error instanceof Error) {
      throw new CliError(
        `${error.message}\n\ndestroy evaluates the same stack program as deploy, which packages ` +
          'the built artifacts — so the app must be built first. Run the build, then retry the destroy.',
      );
    }
    throw error;
  }

  // 7. Resolve the app's Project + (named stage) Branch via the Management
  // API — deploy creates-if-absent, destroy finds only — after assembly
  // succeeds, so a deploy that cannot assemble never creates anything in
  // Prisma Cloud.
  const { projectId, branchId } = await (deps.ensureContainers ?? ensureContainers)({
    command: args.command,
    appName: name,
    stage,
  });

  // 7.5 Preflight (deploy only): each extension verifies its platform
  // prerequisites — e.g. that every secret env var in the provision manifest
  // exists for the resolved stage (ADR-0029) — BEFORE any stack file is written
  // or Alchemy runs, so a missing secret fails fast with nothing side-effected.
  if (args.command === 'deploy') {
    for (const extension of config.extensions) {
      if (extension.preflight === undefined) continue;
      try {
        await extension.preflight({ graph, projectId, branchId, stage });
      } catch (error) {
        throw error instanceof CliError
          ? error
          : new CliError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  // 8. Generate .prisma-composer/alchemy.run.ts (tool state lives where you run the tool).
  const stackPath = writeStackFile({
    entryPath: entryModule.path,
    cwd,
    configPath,
    name,
    assembled,
  });

  // 9. Shell out to alchemy against the generated file.
  try {
    const status = (deps.alchemy ?? runAlchemy)({
      command: args.command,
      stackFileRelativePath: GENERATED_STACK_RELATIVE_PATH,
      cwd,
      stage,
      projectId,
      ...(branchId !== undefined ? { branchId } : {}),
    });
    if (status !== 0) {
      console.error(`\nGenerated stack file: ${stackPath}`);
      console.error(
        `Run \`alchemy ${args.command} ${GENERATED_STACK_RELATIVE_PATH} --yes\` from ` +
          `${cwd} to reproduce this directly.`,
      );
      return status;
    }
    // 9.5 Teardown (destroy only): each extension removes infrastructure it
    // owns outside the stack — the destroy above may still have been reading
    // it, and the containers below may refuse to go while it exists. What that
    // infrastructure is, and whether losing it should fail the command, is the
    // extension's business, not this module's.
    if (args.command === 'destroy') {
      for (const extension of config.extensions) {
        if (extension.teardown === undefined) continue;
        try {
          await extension.teardown({ projectId, branchId, stage });
        } catch (error) {
          throw error instanceof CliError
            ? error
            : new CliError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (args.command === 'destroy' && branchId !== undefined) {
      await (deps.deleteBranch ?? ((input) => deleteStageBranch(input)))({ branchId });
    } else if (args.command === 'destroy') {
      await (deps.deleteProject ?? ((input) => deleteAppProject(input)))({ projectId });
    }
    return status;
  } catch (error) {
    console.error(`\nGenerated stack file: ${stackPath}`);
    throw error;
  }
}
