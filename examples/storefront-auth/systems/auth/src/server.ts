// The app's own entrypoint (the build adapter's `entry`) — the pack-printed
// bootstrap dynamically imports this AFTER main.run(address, boot) has
// re-keyed the platform environment address-free, so service.load() below
// reads it directly, with no address.

import { serve } from '@prisma/app-rpc';
import { SQL } from 'bun';
import service from './service.ts';

const { db } = service.load(); // db: PostgresConfig — the app owns its client
const { port } = service.config(); // config params are read separately from deps (ADR-0021)

// The app constructs its own client from the binding (ADR-0015). Module-scoped,
// so it is one pool per process. idleTimeout closes the pooled connection
// before Compute's scale-to-zero drops it, so the next request reconnects
// instead of erroring (FT-5219).
const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });

// A Prisma Postgres direct connection is closed when it goes idle (and when
// the service scales to zero). Bun.SQL surfaces that as an async error with
// no awaiter, which would otherwise crash the process into a 502 restart
// loop. Keep the process alive; the pool reconnects on the next query.
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

// Prove the DB is reachable; a failed ping returns `{ ok: false }` rather
// than throwing, so the platform sees an unhealthy dependency, not a crash.
const handler = serve(service, {
  rpc: {
    verify: async () => {
      try {
        await sql`select 1`;
        return { ok: true };
      } catch (err) {
        console.error('db query failed', err);
        return { ok: false };
      }
    },
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
