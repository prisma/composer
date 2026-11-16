import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute, rawPostgres } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';
import { authContract } from './contract.ts';

// The `db` dependency is pure requirement: its binding is RawPostgresConfig
// (`{ url }`), and the app builds its own SQL client from it in server.ts
// (ADR-0015). No driver choice lives in the declaration.
export default compute({
  name: 'auth',
  deps: {
    db: rawPostgres(),
  },
  // The root provisions the platform secret and passes its value down, so
  // this service never knows the variable's name.
  input: type({
    signingKey: secretString(),
  }),
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },
});
