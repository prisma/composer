/**
 * The dev STACK's own config — deliberately narrower than the shared
 * `test/integration/prisma-composer.config.ts` (which also lists
 * `nodeBuild()`, needed for THAT config's own CLI-driven assemble step).
 * `lower()`'s node-lowering loop never reads a service's `build.extension`
 * (only `descriptorFor`'s lookup via the node's own `.extension` field, which
 * for every node in this fixture is `@prisma-cloud`) — the build registry is
 * consulted only by `assembleServices`, a CLI/tooling-level concern outside
 * `lower()` entirely — so `nodeBuild()` is not needed here.
 *
 * This sidesteps an unresolved spec gap recorded in
 * `.drive/projects/local-dev/spec.md`'s Open Questions: `mergedDevProviders`
 * throws for ANY configured extension with no `dev` descriptor, including a
 * build-only one, which cannot sensibly implement one (see the recorded
 * question for the full analysis and why this is a real gap, not just a
 * test-fixture quirk).
 */
import { defineConfig } from '@prisma/composer/config';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud()],
  state: prismaState(),
});
