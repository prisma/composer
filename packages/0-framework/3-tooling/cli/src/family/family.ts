/**
 * Composer's `CommandFamily` — the unit the engine mounts, whether the process
 * is composer's own CLI or the `prisma` bin.
 *
 * This module and everything it reaches statically must stay free of alchemy
 * and of effect VALUE imports: the `prisma` bin imports the family directly,
 * so anything in this static graph loads on `prisma --version`. The mechanism
 * that holds it is the existing lazy boundary inside the operation modules —
 * `operations/deploy.ts`, `destroy.ts`, `dev.ts` and `log.ts` each `await
 * import()` their executor, and it is the executors that reach the provider
 * tree. Importing the operations here is therefore free; importing an
 * executor, or flattening one of those dynamic imports, is not.
 * scripts/check-family-static-graph.mjs enforces this against BUILT output,
 * where type-only imports have already been erased.
 *
 * The four commands close over the operations they are given, so a host can
 * mount this family against the test double and exercise real grammar, real
 * arg validation and real handlers with no alchemy behind them.
 */
import { DOCS_BASE } from '@internal/foundation/errors';
import { type CommandFamily, defineCommandFamily } from '@prisma/cli-engine';
import { deployWithDeps } from '../operations/deploy.ts';
import { destroyWithDeps } from '../operations/destroy.ts';
import { devWithDeps } from '../operations/dev.ts';
import { logWithDeps } from '../operations/log.ts';
import { createDeployCommand } from './commands/deploy.ts';
import { createDestroyCommand } from './commands/destroy.ts';
import { createDevCommand } from './commands/dev.ts';
import { createLogCommand } from './commands/log.ts';
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
  readonly destroy: typeof destroyWithDeps;
  readonly dev: typeof devWithDeps;
  readonly log: typeof logWithDeps;
}

export const realOperations: ComposerOperations = {
  deploy: deployWithDeps,
  destroy: destroyWithDeps,
  dev: devWithDeps,
  log: logWithDeps,
};

export interface CreateComposerFamilyOptions {
  /** Defaults to the real control operations. */
  readonly operations?: ComposerOperations | undefined;
}

export function createComposerFamily(options: CreateComposerFamilyOptions = {}): CommandFamily {
  const operations = options.operations ?? realOperations;
  return defineCommandFamily({
    configSection: composerSection,
    commands: {
      deploy: createDeployCommand(operations),
      destroy: createDestroyCommand(operations),
      dev: createDevCommand(operations),
      log: createLogCommand(operations),
    },
    docsBaseUrl: DOCS_BASE,
  });
}
