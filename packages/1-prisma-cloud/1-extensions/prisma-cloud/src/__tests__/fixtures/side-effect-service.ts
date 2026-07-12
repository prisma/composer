import { compute, postgres } from '../../index.ts';

// Importing this module must run nothing (invariant 3): constructing nodes is
// pure, and the postgres() dependency carries no user code — its binding is
// PostgresConfig, built by identity hydrate. This marker just proves the
// module evaluated without throwing or reading the environment.
export const imported = true;

export default compute({
  name: 'test-service',
  deps: {
    db: postgres(),
  },
  build: {
    extension: '@prisma/compose/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});
