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
 * D2 ships the skeleton: the section token, the injection seam, and the
 * family itself. The four commands arrive in D3.
 */
import { DOCS_BASE } from '@internal/foundation/errors';
import { type CommandFamily, defineCommandFamily } from '@prisma/cli-engine';
import { deploy } from '../operations/deploy.ts';
import { destroy } from '../operations/destroy.ts';
import { dev } from '../operations/dev.ts';
import { log } from '../operations/log.ts';
import { composerSection } from './section.ts';

/**
 * The control-plane operations the family's handlers call. Taking them as an
 * argument is what lets a host mount the family against the published test
 * double (`@prisma/composer/testing`) and get real grammar, real arg
 * validation and real handlers without alchemy, containers or a network —
 * which is how prisma-cli tests its mount of this family.
 */
export interface ComposerOperations {
  readonly deploy: typeof deploy;
  readonly destroy: typeof destroy;
  readonly dev: typeof dev;
  readonly log: typeof log;
}

export const realOperations: ComposerOperations = { deploy, destroy, dev, log };

export interface CreateComposerFamilyOptions {
  /** Defaults to the real control operations. */
  readonly operations?: ComposerOperations | undefined;
}

export function createComposerFamily(options: CreateComposerFamilyOptions = {}): CommandFamily {
  const operations = options.operations ?? realOperations;
  // The skeleton mounts no commands, so nothing consumes `operations` yet —
  // D3's four handlers close over it. The seam exists now because the
  // signature is what prisma-cli writes its family tests against, and
  // discovering it in D3 would mean rewriting them.
  void operations;
  return defineCommandFamily({
    configSection: composerSection,
    commands: {},
    docsBaseUrl: DOCS_BASE,
  });
}
