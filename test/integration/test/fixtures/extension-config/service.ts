import { module } from '@prisma/composer';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

/**
 * A real (not faked) service: `@prisma/integration-tests` genuinely depends
 * on `@prisma/composer/node` and `@prisma/composer-prisma-cloud`, and the `composer`
 * section of this package's own `prisma.config.ts` (found by the engine from
 * the run's cwd) imports both packages' REAL `/control` entries, so `prisma-composer deploy`
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
    { id: 'app' },
  );
  return {};
});
