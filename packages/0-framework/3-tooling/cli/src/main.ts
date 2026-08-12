/**
 * Argument parsing (clipanion — prisma-next's CLI idiom, see
 * prisma-next/packages/1-framework/3-tooling/cli/src/migration-cli.ts) +
 * orchestration of deploy-cli.md § The pipeline.
 */
import { CliStructuredError } from '@internal/foundation/errors';
import { Cli, Command, Option, UsageError } from 'clipanion';
import { runDev } from './dev/run-dev.ts';
import { runLog } from './log/run-log.ts';
import { deployWithDeps } from './operations/deploy.ts';
import { type DestroyTarget, destroyWithDeps } from './operations/destroy.ts';
import type { OperationDeps } from './operations/shared.ts';
import { renderChildStatusHints } from './render-error.ts';

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
    examples: [
      ['Deploy an app', '$0 deploy src/service.ts'],
      ['Deploy and record the outcome as JSON', '$0 deploy src/service.ts --report run.json'],
    ],
  });
  readonly action = 'deploy' as const;

  report = Option.String('--report', {
    description:
      "Write the deploy's outcome as JSON to this path — resources, preview URLs, and the " +
      'failure cause when there is one. Also settable as PRISMA_COMPOSER_REPORT_FILE.',
  });

  // Named for what a user reads in their target's console — a build — not for
  // this CLI's own `build` (a service's build adapter, ADR-0005). Nothing else
  // on this surface takes a build id, so the two cannot collide at the command
  // line, and `--build-id` is the name someone copying an id from their CI
  // will reach for.
  buildId = Option.String('--build-id', {
    description:
      'Join the deploy record your CI already created rather than letting the target create ' +
      'one — for a workflow that opens the record, runs several steps against it, then ' +
      'closes it. Each target also reads its own environment variable for this; the flag wins.',
  });
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
  /** `deploy` only — where to write the run report. */
  readonly report?: string | undefined;
  /** `deploy` only — an existing deploy record to join (`--build-id`). */
  readonly buildId?: string | undefined;
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
      report: command instanceof DeployCommand ? command.report : undefined,
      buildId: command instanceof DeployCommand ? command.buildId : undefined,
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

/** Injectable seams so tests can drive run() without a real wrapper build, config evaluation, or alchemy process — the operations' own OperationDeps, under the CLI's historical name. */
export type RunDeps = OperationDeps;

/**
 * Renders a deploy/destroy operation failure the way run() always has: an
 * alchemy exit becomes the two console.error hint lines and the child's own
 * status (the documented ADR-0044 child-status exception); everything else
 * rethrows the structured failure so cli.ts renders its envelope.
 */
function renderDeployDestroyFailure(failure: CliStructuredError): number {
  const status = renderChildStatusHints(failure);
  if (status !== undefined) return status;
  throw failure;
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

  // Flag semantics stay the CLI's: the operations take discriminated inputs,
  // so the string-flag combinations are validated here, with the same errors
  // run() has always thrown (spec §10 — destroy must name its target).
  if (args.command === 'deploy') {
    if (args.production) {
      throw new CliStructuredError(
        'DEPLOY.FLAG_INVALID',
        '--production is only valid with `destroy`.',
        {
          fix: '`deploy` targets production by default (omit --stage).',
        },
      );
    }
    const result = await deployWithDeps(
      {
        entry: args.entry,
        name: args.name,
        stage: args.stage,
        reportPath: args.report,
        reportId: args.buildId,
      },
      deps,
    );
    if (result.ok) return 0;
    return renderDeployDestroyFailure(result.failure);
  }

  if (args.stage !== undefined && args.production) {
    throw new CliStructuredError(
      'DEPLOY.TARGET_CONFLICT',
      'Pass either --stage <name> or --production to `destroy`, not both.',
    );
  }
  if (args.stage === undefined && !args.production) {
    throw new CliStructuredError(
      'DEPLOY.TARGET_MISSING',
      '`destroy` requires an explicit target.',
      {
        fix:
          'Pass --stage <name> to tear down a branch environment, or --production to tear ' +
          'down the production environment.',
      },
    );
  }
  const target: DestroyTarget =
    args.stage !== undefined ? { kind: 'stage', stage: args.stage } : { kind: 'production' };

  const result = await destroyWithDeps(
    {
      entry: args.entry,
      name: args.name,
      target,
      onEvent: (event) => {
        if (event.kind === 'no-local-deploy-state') {
          console.warn(
            `\nNo prior deploy state under ${event.cwd} — if you deployed from a different directory, run ` +
              'destroy from there; otherwise this is a no-op.',
          );
        }
      },
    },
    deps,
  );
  if (result.ok) return 0;
  return renderDeployDestroyFailure(result.failure);
}
