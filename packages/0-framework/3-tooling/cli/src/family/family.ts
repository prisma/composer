/**
 * Composer's `CommandFamily`: the unit the `prisma` bin mounts.
 *
 * This module and everything it reaches statically must stay free of alchemy
 * and of effect VALUE imports: the `prisma` bin imports the family directly,
 * so anything in this static graph loads on `prisma --version`. The mechanism
 * that holds it is the existing lazy boundary inside the operation modules —
 * `operations/deploy.ts` and `dev.ts` each `await import()` their executor,
 * and it is the executors that reach the provider tree. Importing the operations here is therefore free; importing an
 * executor, or flattening one of those dynamic imports, is not.
 * scripts/check-family-static-graph.mjs enforces this against BUILT output,
 * where type-only imports have already been erased.
 *
 * The commands close over the operations they are given, so a host can
 * mount this family against the test double and exercise real grammar, real
 * arg validation and real handlers with no alchemy behind them.
 *
 * The family ships `deploy`, `dev`, `dev url` and `dev stop`, keyed by the
 * path they are meant to mount at; the host decides where each one mounts.
 * A host may add commands of its own through `commands` — the published
 * family adds `deploy list` and `emulator list`, which need Prisma Cloud
 * code. `destroy` and `log` are programmatic operations in
 * `@prisma/composer/control`, not commands.
 */
import { type CommandFamily, defineCommandFamily, type RedirectSpec } from '@prisma/cli-engine';
import { deployWithDeps } from '../operations/deploy.ts';
import { devWithDeps } from '../operations/dev.ts';
import { devStop, devUrl } from '../operations/dev-current.ts';
import { createDeployCommand } from './commands/deploy.ts';
import { createDevCommand } from './commands/dev.ts';
import { createDevStopCommand } from './commands/dev-stop.ts';
import { createDevUrlCommand } from './commands/dev-url.ts';
import { composerSection } from './section.ts';

/**
 * The control-plane operations the family's handlers call. These are the
 * deps-taking variants, not the bare ones: a handler must inject the converge
 * spawn adapter (so the ENGINE starts the child and owns signal policy) and
 * the credentials the in-process leg authenticates with. A double that
 * honours `deps.alchemy` therefore exercises the real settlement path
 * against a scripted fake child.
 */
export interface ComposerOperations {
  readonly deploy: typeof deployWithDeps;
  readonly dev: typeof devWithDeps;
  readonly devUrl: typeof devUrl;
  readonly devStop: typeof devStop;
}

export const realOperations: ComposerOperations = {
  deploy: deployWithDeps,
  dev: devWithDeps,
  devUrl,
  devStop,
};

export interface CreateComposerFamilyOptions {
  /** Defaults to the real control operations. */
  readonly operations?: ComposerOperations | undefined;
  /** More commands to ship in the family, keyed by the path they are meant to mount at. */
  readonly commands?: CommandFamily['commands'] | undefined;
  /** More retired invocations to redirect, for the commands in `commands`. */
  readonly redirects?: readonly RedirectSpec[] | undefined;
}

/** The `prisma` CLI's error reference; the engine appends `/<CODE>` to it for every error envelope. */
const CLI_DOCS_BASE = 'https://www.prisma.io/docs/cli/error-reference/';

/** Retires `--stage` on `command` in favour of `--environment`, so typing it fails with `CLI.COMMAND_MOVED`. */
function retiredStageFlagRedirect(command: string): RedirectSpec {
  return {
    from: command,
    flag: 'stage',
    replacement: `${command} --environment <name>`,
    reason: 'A place the app runs is now called an environment.',
  };
}

type V7RedirectEntry = Omit<RedirectSpec, 'from' | 'flag' | 'code' | 'summary'>;

function v7Command(from: string, entry: V7RedirectEntry): RedirectSpec {
  return {
    from,
    code: 'CLI.V7_COMMAND',
    summary: `\`{bin} ${from}\` is a Prisma 7 command and is not available in Prisma 8`,
    ...entry,
  };
}

function v7Flag(command: string, flag: string, entry: V7RedirectEntry): RedirectSpec {
  return {
    from: command,
    flag,
    code: 'CLI.V7_FLAG',
    summary: `\`--${flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}\` on \`{bin} ${command}\` is a Prisma 7 flag and is not available in Prisma 8`,
    ...entry,
  };
}

const ENVIRONMENT =
  'environment (a separate local copy of the app: the one named dev unless `--environment` names another)';

const DEV_PORTS_REASON =
  `\`dev\` takes no port options. Each ${ENVIRONMENT} gets its own ports for its services, ` +
  'databases and buckets and keeps them between runs. While `dev` runs, `dev url <address>` ' +
  'prints where one service, database or bucket answers; its address is its path from the app ' +
  'name, with dots between names, such as `shop.catalog.database`.';

const V7_REDIRECTS: readonly RedirectSpec[] = [
  v7Command('dev ls', {
    replacement: '{bin} emulator list',
    help: 'emulator list',
    reason:
      '`emulator list` lists the local emulators on this machine, the programs `dev` starts to ' +
      "run the app's services, databases and buckets, with every instance each one holds.",
  }),
  v7Command('dev rm', {
    replacement: '{bin} dev --fresh',
    help: 'dev',
    reason:
      "`dev --fresh` deletes this app's local services, databases and buckets, and their data, " +
      `in one ${ENVIRONMENT}, then starts the app again. \`dev stop\` only stops the ` +
      "app's service processes and local database servers, and keeps their data.",
  }),
  v7Command('dev start', {
    replacement: '{bin} dev --detach',
    help: 'dev',
    reason:
      '`dev --detach` runs the app locally in the background: it returns once every service ' +
      'answers and leaves the app running, without watching for changes, until `dev stop`.',
  }),
  ...['port', 'dbPort', 'shadowDbPort'].map((flag) =>
    v7Flag('dev', flag, { help: 'dev', reason: DEV_PORTS_REASON }),
  ),
  v7Flag('dev', 'debug', {
    help: 'dev',
    reason:
      '`dev` has no debug output option. It shows the output of each service that runs a dev ' +
      "server, such as `next dev`, prefixed with the service's address.",
  }),
  v7Flag('dev stop', 'debug', {
    help: 'dev stop',
    reason: '`dev stop` has no debug output option.',
  }),
];

export function createComposerFamily(options: CreateComposerFamilyOptions = {}): CommandFamily {
  const operations = options.operations ?? realOperations;
  return defineCommandFamily({
    configSection: composerSection,
    commands: {
      deploy: createDeployCommand(operations),
      dev: createDevCommand(operations),
      'dev url': createDevUrlCommand(operations),
      'dev stop': createDevStopCommand(operations),
      ...options.commands,
    },
    docsBaseUrl: CLI_DOCS_BASE,
    redirects: [retiredStageFlagRedirect('deploy'), ...V7_REDIRECTS, ...(options.redirects ?? [])],
  });
}
