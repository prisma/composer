import { secret } from '@prisma/compose';
import node from '@prisma/compose/node';
import { compute, postgres } from '@prisma/compose-prisma-cloud';
import { authContract } from './contract.ts';

// The `db` dependency is pure requirement: its binding is PostgresConfig
// (`{ url }`), and the app builds its own SQL client from it in server.ts
// (ADR-0015). No driver choice lives in the declaration.
export default compute({
  name: 'auth',
  deps: {
    db: postgres(),
  },
  // A secret NEED (ADR-0029) — nameless here. The root binds it to a platform
  // env-var name via `envSecret`, and the auth module forwards it in; this
  // service never knows the name. Read via `secrets().signingKey.expose()`.
  secrets: {
    signingKey: secret(),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },
});
