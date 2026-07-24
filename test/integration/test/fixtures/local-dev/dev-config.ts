/**
 * The dev STACK's own config. Matches the shared
 * `test/integration/prisma-composer.config.ts` shape, including `nodeBuild()`
 * — the same build-only extension `deploy`'s assemble step routes through
 * (`config.extensions[build.extension].nodes[build.type]`) and dev needs to
 * accept without throwing (`mergedDevProviders`'s build-only exemption,
 * ADR-0041): `isBuildOnlyExtension` recognizes `nodeBuild()` (every `nodes`
 * entry is `kind: 'build'`, no `providers`/`application`/`provisions`/
 * `container`) and `mergedDevProviders` skips it rather than throwing.
 */
import { defineConfig } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  state: prismaState(),
});
