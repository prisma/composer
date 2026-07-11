import { compute, postgres } from '@prisma/app-cloud';
import node from '@prisma/app-node';
import { authContract } from './contract.ts';

// The `db` dependency is pure requirement: its binding is PostgresConfig
// (`{ url }`), and the app builds its own SQL client from it in server.ts
// (ADR-0015). No driver choice lives in the declaration.
export default compute({
  name: 'auth',
  deps: {
    db: postgres(),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },
});
