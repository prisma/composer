/**
 * Argument parsing + orchestration of deploy-cli.md § The pipeline.
 */
import { Load } from '@makerkit/core';
import { assembleServices, type RunAssembler } from './assemble-services.ts';
import { CliError } from './cli-error.ts';
import { GENERATED_STACK_RELATIVE_PATH, writeStackFile } from './generate-stack.ts';
import { inferTarget } from './infer-target.ts';
import { loadEntry } from './load-entry.ts';
import { type RunAlchemyInput, runAlchemy } from './run-alchemy.ts';

export const USAGE = `Usage: makerkit <deploy|destroy> <entry> [--name <name>] [--stage <stage>]

  <entry>   Path to the module whose default export is the app's root node
            (a service or hex, from @makerkit/core's service()/hex()).
            Resolved against the current directory.

  --name    Override the root node's name — the deploy's application name.
  --stage   Alchemy stage to target.
`;

export class UsageError extends Error {}

export interface ParsedArgs {
  readonly command: 'deploy' | 'destroy';
  readonly entry: string;
  readonly name: string | undefined;
  readonly stage: string | undefined;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== 'deploy' && command !== 'destroy') {
    throw new UsageError(USAGE);
  }

  let entry: string | undefined;
  let name: string | undefined;
  let stage: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--name') {
      name = rest[i + 1];
      i++;
    } else if (arg === '--stage') {
      stage = rest[i + 1];
      i++;
    } else if (arg !== undefined && !arg.startsWith('--') && entry === undefined) {
      entry = arg;
    } else {
      throw new UsageError(USAGE);
    }
  }

  if (entry === undefined) throw new UsageError(USAGE);

  return { command, entry, name, stage };
}

/** Injectable seams so tests can drive run() without a real wrapper build or alchemy process. */
export interface RunDeps {
  /** Substituted into assembleServices — see RunAssembler. */
  readonly runAssembler?: RunAssembler;
  readonly alchemy?: (input: RunAlchemyInput) => number;
}

/** Runs the full pipeline; returns the process exit code. */
export async function run(argv: readonly string[], deps: RunDeps = {}): Promise<number> {
  const args = parseArgs(argv);
  const cwd = process.cwd();

  // 1. Import the entry module; its default export must be a node.
  const entryModule = await loadEntry(args.entry, cwd);

  // 2. Load — core's LoadError (unwired connection input, etc.) surfaces as-is.
  const graph = Load(entryModule.root);
  const isHexRoot = graph.root.node.kind === 'hex';

  // 3. Infer the target — anchored at the entry module itself (node's resolver
  // walks node_modules upward from there natively); validates the pack's env
  // NOW, before any assembly work.
  const { pack } = await inferTarget(graph, entryModule.path);

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
    assembled = await assembleServices(graph, isHexRoot, entryModule.path, deps.runAssembler);
  } catch (error) {
    if (args.command === 'destroy' && error instanceof Error) {
      throw new CliError(
        `${error.message}\n\ndestroy evaluates the same stack program as deploy, which packages ` +
          'the built artifacts — so the app must be built first. Run the build, then retry the destroy.',
      );
    }
    throw error;
  }

  // 6. Generate .makerkit/alchemy.run.ts inside the process's own cwd — tool
  // state lives where you run the tool (ADR-0004's rewrite).
  const stackPath = writeStackFile({
    entryPath: entryModule.path,
    cwd,
    pack,
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
