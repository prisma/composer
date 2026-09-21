import { compute, rawPostgres } from '../../exports/index.ts';

// Importing this module must run nothing (invariant 3): constructing nodes is
// pure, and the rawPostgres() dependency carries no user code — its binding is
// RawPostgresConfig, built by identity hydrate. This marker just proves the
// module evaluated without throwing or reading the environment.
export const imported = true;

export default compute({
  name: 'test-service',
  deps: {
    db: rawPostgres(),
  },
  build: {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});
