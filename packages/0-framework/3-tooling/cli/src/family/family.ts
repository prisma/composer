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
    redirects: [retiredStageFlagRedirect('deploy'), ...(options.redirects ?? [])],
  });
}
