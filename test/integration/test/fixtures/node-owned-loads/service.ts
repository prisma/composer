import { hex } from '@prisma/app';
import { compute } from '@prisma/app-cloud';
import node from '@prisma/app-node';

/**
 * A real (not faked) service: `@prisma/integration-tests` genuinely
 * depends on `@prisma/app-node` and `@prisma/app-cloud`, so `makerkit
 * deploy` resolves both packs' `/target` and `/assemble` entries for real —
 * node-owned loads (the node's own `loadTarget()`/`assemble()` import them,
 * @prisma/app's node.ts), from this app's own dependency tree, not
 * anchored at any file — see `../cli.node-owned-loads.test.ts`. The deploy
 * root must be a hex.
 */
export default hex('node-owned-loads-fixture', {}, ({ provision }) => {
  provision(
    'node-owned-loads-fixture',
    compute({
      name: 'node-owned-loads-fixture',
      deps: {},
      build: node({ module: import.meta.url, entry: 'dist/server.js' }),
    }),
  );
  return {};
});
