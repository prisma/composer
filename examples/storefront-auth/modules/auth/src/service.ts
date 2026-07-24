import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute, postgres } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';
import { authContract } from './contract.ts';

// The `db` dependency is pure requirement: its binding is PostgresConfig
// (`{ url }`), and the app builds its own SQL client from it in server.ts
// (ADR-0015). No driver choice lives in the declaration.
export default compute({
  name: 'auth',
  deps: {
    db: postgres(),
  },
  // The whole incoming configuration as ONE schema (ADR-0042): a single
  // secret field, typed as the redacting SecretString box. The auth module
  // forwards its boundary secret slot as this field's binding leaf; the root
  // names the platform var via `envSecret` — this service never knows the
  // name. Read via `input().signingKey.expose()`.
  input: type({
    signingKey: secretString(),
  }),
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },
});
