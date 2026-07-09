import node from '@makerkit/node';
import { compute, postgres } from '@makerkit/prisma-cloud';
import { SQL } from 'bun';
import { authContract } from './contract.ts';

// idleTimeout closes the pooled connection before Compute's scale-to-zero drops
// it, so the next request reconnects instead of erroring (FT-5219).
export default compute({
  name: 'auth',
  url: import.meta.url,
  deps: {
    db: postgres({ name: 'db', client: ({ url }) => new SQL({ url, max: 1, idleTimeout: 10 }) }),
  },
  build: node({ entry: 'server.js' }),
  expose: { rpc: authContract },
});
