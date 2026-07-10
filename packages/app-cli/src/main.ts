/**
 * Argument parsing (clipanion — prisma-next's CLI idiom, see
 * prisma-next/packages/1-framework/3-tooling/cli/src/migration-cli.ts) +
 * orchestration of deploy-cli.md § The pipeline.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Load } from '@prisma/app';
import { assembleServices, type RunAssembler } from '@prisma/app-assemble';
import { Cli, Command, Option, UsageError } from 'clipanion';
import { CliError } from './cli-error.ts';
import { GENERATED_STACK_RELATIVE_PATH, writeStackFile } from './generate-stack.ts';
import { loadEntry } from './load-entry.ts';
import { type RunAlchemyInput, runAlchemy } from './run-alchemy.ts';
import { extractFromEnv, targetNodeOf } from './target.ts';

const BINARY_NAME = 'prisma-app';

/**
 * The `<entry>`/`--name`/`--stage` surface shared by deploy and destroy
 * (deploy-cli.md § Scope). `execute()` is unused: `run()` below drives the
 * pipeline directly against the parsed options so error routing and exit
 * codes stay under this module's own control — the `RunDeps` test seams (and
 * bin.ts's own error handling) need to observe thrown errors, not have them
 * swallowed and printed by clipanion's own `cli.run()`.
 */
abstract class DeployCliCommand extends Command {
  entry = Option.String({ name: 'entry' });

  name = Option.String('--name', {
    description: "Override the root node's name — the deploy's application name.",
  });

  stage = Option.String('--stage', {
    description: 'Alchemy stage to target.',
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
    binaryLabel: 'The prisma-app deploy CLI',
  });
}

/** Thrown internally when the user explicitly asked for `--help`/`-h` — run() prints it to stdout and exits 0; not a usage error. */
class HelpRequested extends Error {}

/**
 * clipanion's `UnknownSyntaxError` — thrown for an unmatched command, a
 * missing required positional, an option missing its value, or an unknown
 * flag — isn't re-exported from its main entry (only `UsageError` is), so
 * it's duck-typed via its `name` and the `clipanion.type` discriminator every
 * clipanion error carries (mirrors prisma-next's migration-cli.ts).
 */
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

/** Injectable seams so tests can drive run() without a real wrapper build or alchemy process. */
export interface RunDeps {
  /** Substituted into assembleServices — see @prisma/app-assemble's RunAssembler. */
  readonly runAssembler?: RunAssembler;
  readonly alchemy?: (input: RunAlchemyInput) => number;
}

const ALCHEMY_STATE_DIR = '.alchemy';

/**
 * R2a-review guardrail: `destroy` evaluates the alchemy stack against local
 * state under cwd. If that state is missing or empty, warn — don't fail —
 * before the alchemy invocation: the most likely explanations are "deployed
 * from a different directory" (nothing to destroy from here) or "nothing was
 * ever deployed" (destroy is a no-op either way). The CI destroy-guard script
 * already skips the CLI entirely when `.alchemy` is absent; this covers the
 * direct-invocation path that script doesn't gate.
 */
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
  const cwd = process.cwd();

  // 0. destroy-only guardrail — first, ahead of every other step, so it
  // surfaces even when the rest of the pipeline goes on to fail for an
  // unrelated reason (missing target env, missing built output — both common
  // companions of "nothing was ever deployed from here").
  if (args.command === 'destroy') {
    warnIfNoLocalDeployState(cwd);
  }

  // 1. Import the entry module; its default export must be a node.
  const entryModule = await loadEntry(args.entry, cwd);

  // 2. Load — core's LoadError (unwired connection input, etc.) surfaces as-is.
  const graph = Load(entryModule.root);
  if (graph.root.node.kind !== 'system') {
    throw new CliError(
      'The deploy root must be a system — wrap your service, e.g. ' +
        "export default system('name', {}, ({ provision }) => { provision('name', service); return {}; }).",
    );
  }

  // 3. The one target (ADR-0003): find a node that carries it and ask it to
  // load its own target (ADR-0017 — the node resolves next to its packs), then
  // read the target's env NOW so it fails before slow assembly work.
  const { node: targetNode, targetModule } = targetNodeOf(graph);
  extractFromEnv(targetModule, await targetNode.loadTarget())();

  // 4. Resolve the name.
  const name = args.name ?? entryModule.root.name;
  if (name.length === 0) {
    throw new CliError('The root node has no name — name it at authoring, or pass --name.');
  }

  // 5. Assemble each service. A destroy evaluates the same stack program as a
  // deploy (the generated file's lower() packages the artifacts), so missing
  // built output blocks destroy too — say so instead of just "run your build".
  let assembled: Awaited<ReturnType<typeof assembleServices>>;
  try {
    assembled = await assembleServices(graph, deps.runAssembler);
  } catch (error) {
    if (args.command === 'destroy' && error instanceof Error) {
      throw new CliError(
        `${error.message}\n\ndestroy evaluates the same stack program as deploy, which packages ` +
          'the built artifacts — so the app must be built first. Run the build, then retry the destroy.',
      );
    }
    throw error;
  }

  // 6. Generate .prisma-app/alchemy.run.ts inside the process's own cwd — tool
  // state lives where you run the tool (ADR-0004's rewrite).
  const stackPath = writeStackFile({
    entryPath: entryModule.path,
    cwd,
    targetModule,
    name,
    assembled,
  });

  // 7. Shell out to alchemy against the generated file.
  try {
    const status = (deps.alchemy ?? runAlchemy)({
      command: args.command,
      stackFileRelativePath: GENERATED_STACK_RELATIVE_PATH,
      cwd,
      stage: args.stage,
    });
    if (status !== 0) {
      console.error(`\nGenerated stack file: ${stackPath}`);
      console.error(
        `Run \`alchemy ${args.command} ${GENERATED_STACK_RELATIVE_PATH} --yes\` from ` +
          `${cwd} to reproduce this directly.`,
      );
    }
    return status;
  } catch (error) {
    console.error(`\nGenerated stack file: ${stackPath}`);
    throw error;
  }
}
