import node from '@makerkit/node';
import { compute } from '@makerkit/prisma-cloud';

/**
 * A real (not faked) service: `@makerkit/integration-tests` genuinely
 * depends on `@makerkit/node` and `@makerkit/prisma-cloud`, so `makerkit
 * deploy` resolves both packs' `/target` and `/assemble` entries for real,
 * anchored at this fixture's entry package (test/integration itself) — see
 * `../cli.entry-anchored-resolution.test.ts`.
 */
export default compute({
  name: 'entry-anchored-fixture',
  url: import.meta.url,
  deps: {},
  build: node({ entry: 'dist/server.js' }),
});
