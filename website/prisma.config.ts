/**
 * The app's configuration. The `composer` section is its control-plane config
 * (ADR-0017), read only by `prisma-composer deploy`/`destroy`/`dev`/`log` and
 * never imported by app code. Its static imports are the one place the
 * extensions' /control entries (provisioning, bundlers, alchemy) enter the
 * deploy; they resolve from this app's own dependencies.
 */
import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default definePrismaConfig({
  composer: defineConfig({
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
});
