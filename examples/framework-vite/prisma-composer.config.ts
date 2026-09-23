import { defineConfig } from '@prisma/composer/config';
import { frameworkBuild } from '@prisma/composer/frameworks/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), frameworkBuild()],
  state: prismaState(),
});
