/**
 * Argument parsing (clipanion — prisma-next's CLI idiom, see
 * prisma-next/packages/1-framework/3-tooling/cli/src/migration-cli.ts) +
 * orchestration of deploy-cli.md § The pipeline.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunAssembler } from '@internal/assemble';
import type { ContainerInstance, PrismaAppConfig } from '@internal/core/config';
import { containerEnv } from '@internal/core/config';
import { Cli, Command, Option, UsageError } from 'clipanion';
import { CliError } from './cli-error.ts';
import { runDev } from './dev/run-dev.ts';
import { GENERATED_STACK_RELATIVE_PATH, writeStackFile } from './generate-stack.ts';
import { runLog } from './log/run-log.ts';
import { type PipelineDeps, runPipeline } from './pipeline.ts';
import { type RunAlchemyInput, runAlchemy } from './run-alchemy.ts';
import { validateStageName } from './validate-stage.ts';

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

/** `<entry>`/`--name`/`--fresh` only — no `--stage`/`--production` (local-dev spec § 6: a working directory has exactly one dev instance, no stages). */
class DevCommand extends Command {
  static override paths = [['dev']];
  static override usage = Command.Usage({
    description:
      "Bring up the application whose root node is <entry>'s default export, entirely on this machine, credential-free.",
    examples: [['Run an app locally', '$0 dev src/service.ts']],
  });

  entry = Option.String({ name: 'entry' });

  name = Option.String('--name', {
    description: "Override the root node's name — the dev instance's application name.",
  });

  fresh = Option.Boolean('--fresh', false, {
    description: 'Destroy the dev stack and wipe the dev state directory before starting.',
  });

  async execute(): Promise<number> {
    return 0;
  }
}

class LogCommand extends Command {
  static override paths = [['log']];
  static override usage = Command.Usage({
    description:
      "Tail the merged logs of the locally-running application whose root node is <entry>'s default export.",
    examples: [
      ['Tail every service', '$0 log src/service.ts'],
      ['Tail one service', '$0 log src/service.ts catalog.service'],
    ],
  });

  entry = Option.String({ name: 'entry' });

  address = Option.String({ name: 'address', required: false });

  name = Option.String('--name', {
    description: "Override the root node's name — the dev instance's application name.",
  });

  tail = Option.String('--tail', {
    description: `How many trailing history lines to show before live output (default ${String(DEFAULT_LOG_TAIL)}).`,
  });

  async execute(): Promise<number> {
    return 0;
  }
}

function buildCli(): Cli {
  return Cli.from([DeployCommand, DestroyCommand, DevCommand, LogCommand], {
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
  readonly command: 'deploy' | 'destroy' | 'dev' | 'log';
  readonly entry: string;
  readonly name: string | undefined;
  readonly stage: string | undefined;
  readonly production: boolean;
  readonly fresh: boolean;
  /** `log` only — restrict output to this one service address. */
  readonly address?: string | undefined;
  /** `log` only — trailing history lines before live output. */
  readonly tail?: number | undefined;
}

/** `log`'s default backlog: an empty screen reads as broken, so show a little recent history before going live. */
const DEFAULT_LOG_TAIL = 20;

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
      fresh: false,
    };
  }

  if (command instanceof DevCommand) {
    return {
      command: 'dev',
      entry: command.entry,
      name: command.name,
      stage: undefined,
      production: false,
      fresh: command.fresh,
    };
  }

  if (command instanceof LogCommand) {
    const tail = command.tail === undefined ? DEFAULT_LOG_TAIL : Number.parseInt(command.tail, 10);
    if (Number.isNaN(tail) || tail < 0) {
      throw new UsageError('`--tail` must be a non-negative integer.');
    }
    return {
      command: 'log',
      entry: command.entry,
      name: command.name,
      stage: undefined,
      production: false,
      fresh: false,
      address: command.address,
      tail,
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
  readonly alchemy?: (input: RunAlchemyInput) => number;
  /** Substituted for the c12 evaluation of the discovered config file (discovery itself still runs — the generated stack file needs the real path). Container lifecycle is stubbed via each extension's own `container` descriptor on this config. */
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

  if (args.command === 'dev') {
    return runDev(args, deps);
  }

  if (args.command === 'log') {
    return runLog(
      {
        entry: args.entry,
        name: args.name,
        address: args.address,
        tail: args.tail ?? DEFAULT_LOG_TAIL,
      },
      { config: deps.config },
    );
  }

  const stage = effectiveStage(args);
  if (stage !== undefined) validateStageName(stage);
  const cwd = process.cwd();

  // 0. destroy-only guardrail — first, ahead of every other step, so it
  // surfaces even when the rest of the pipeline goes on to fail for an
  // unrelated reason (missing config, missing built output — both common
  // companions of "nothing was ever deployed from here").
  if (args.command === 'destroy') {
    warnIfNoLocalDeployState(cwd);
  }

  // 1–6. The shared prefix (pipeline.ts): config discovery/load, entry load,
  // Load, registry coverage, name resolution, assemble.
  const pipelineDeps: PipelineDeps = { runAssembler: deps.runAssembler, config: deps.config };
  const onAssembleError =
    args.command === 'destroy'
      ? (error: Error): CliError =>
          new CliError(
            `${error.message}\n\ndestroy evaluates the same stack program as deploy, which packages ` +
              'the built artifacts — so the app must be built first. Run the build, then retry the destroy.',
          )
      : undefined;
  const { configPath, config, entryModule, graph, name, assembled } = await runPipeline(
    args.entry,
    args.name,
    cwd,
    pipelineDeps,
    onAssembleError,
  );

  // 7. Resolve each extension's own container (e.g. Prisma Cloud's Project +
  // named-stage Branch) via its own descriptor — deploy ensures (creates if
  // absent), destroy locates only — after assembly succeeds, so a deploy
  // that cannot assemble never creates anything on any platform.
  const containers = new Map<string, ContainerInstance>();
  for (const extension of config.extensions) {
    if (extension.container === undefined) continue;
    try {
      if (args.command === 'deploy') {
        containers.set(extension.id, await extension.container.ensure({ appName: name, stage }));
      } else {
        const instance = await extension.container.locate({ appName: name, stage });
        if (instance === undefined) {
          throw new CliError(
            `Nothing deployed for ${name}${stage !== undefined ? `/${stage}` : ''} — deploy it first.`,
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

  // 7.5 Preflight (deploy only): each extension verifies its platform
  // prerequisites — e.g. that every secret env var in the provision manifest
  // exists for the resolved stage (ADR-0029) — BEFORE any stack file is written
  // or Alchemy runs, so a missing secret fails fast with nothing side-effected.
  if (args.command === 'deploy') {
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
      containerEnv: containerEnv(containers),
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
      for (const extension of config.extensions) {
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

    return status;
  } catch (error) {
    console.error(`\nGenerated stack file: ${stackPath}`);
    throw error;
  }
}
