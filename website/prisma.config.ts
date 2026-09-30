/**
 * The app's configuration. The `composer` section is its control-plane config
 * (ADR-0017), read by `prisma deploy`, `prisma dev` and the `destroy` and `log`
 * operations of `@prisma/composer/control`, and never imported by app code. Its static imports are the one place the
 * extensions' /control entries (provisioning, bundlers, alchemy) enter the
 * deploy; they resolve from this app's own dependencies.
 */

import { defineConfig as composer } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  composer: composer({
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
});
