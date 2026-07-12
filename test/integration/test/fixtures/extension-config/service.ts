import { module } from '@prisma/compose';
import { compute } from '@prisma/compose-cloud';
import node from '@prisma/compose-node';

/**
 * A real (not faked) service: `@prisma/integration-tests` genuinely depends
 * on `@prisma/compose-node` and `@prisma/compose-cloud`, and this package's own
 * `prisma-compose.config.ts` (found by the CLI's walk-up from this entry)
 * imports both packages' REAL `/control` entries, so `prisma-compose deploy`
 * resolves them from this app's own dependency tree — see
 * `../../cli.extension-config.test.ts`. The deploy root must be a module.
 */
export default module('extension-config-fixture', {}, ({ provision }) => {
  provision(
    compute({
      name: 'extension-config-fixture',
      deps: {},
      build: node({ module: import.meta.url, entry: 'dist/server.js' }),
    }),
    { id: 'extension-config-fixture' },
  );
  return {};
});
