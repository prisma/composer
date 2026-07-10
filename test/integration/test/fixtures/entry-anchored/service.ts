import { hex } from '@makerkit/core';
import node from '@makerkit/node';
import { compute } from '@makerkit/prisma-cloud';

/**
 * A real (not faked) service: `@makerkit/integration-tests` genuinely
 * depends on `@makerkit/node` and `@makerkit/prisma-cloud`, so `makerkit
 * deploy` resolves both packs' `/target` and `/assemble` entries for real,
 * anchored at this fixture's entry package (test/integration itself) — see
 * `../cli.entry-anchored-resolution.test.ts`. The deploy root must be a hex.
 */
export default hex('entry-anchored-fixture', (h) => {
  h.provision(
    'entry-anchored-fixture',
    compute({
      name: 'entry-anchored-fixture',
      deps: {},
      build: node({ module: import.meta.url, entry: 'dist/server.js' }),
    }),
  );
});
