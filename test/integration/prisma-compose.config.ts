/**
 * The integration app's control-plane config (ADR-0017): REAL /control
 * imports — `@prisma/compose-prisma-cloud/control` and `@prisma/compose/node/control`
 * resolve from this package's own dependency tree, exactly like an end
 * user's app. `prisma-compose deploy` discovers this file by walking up from the
 * fixture entry (test/fixtures/extension-config/service.ts).
 */
import { defineConfig } from '@prisma/compose/config';
import { nodeBuild } from '@prisma/compose/node/control';
import { prismaCloud, prismaState } from '@prisma/compose-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  state: () => prismaState(),
});
