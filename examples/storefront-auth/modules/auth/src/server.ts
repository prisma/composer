// The app's own entrypoint (the build adapter's `entry`) — the pack-printed
// bootstrap dynamically imports this AFTER main.run(address, boot) has
// re-keyed the platform environment address-free, so service.load() below
// reads it directly, with no address.

import { serve } from '@prisma/composer/service-rpc';
import { SQL } from 'bun';
import service from './service.ts';

const { db } = service.load(); // db: PostgresConfig — the app owns its client
const { port } = service.config(); // config params are read separately from deps (ADR-0021)
const { signingKey } = service.secrets(); // signingKey: SecretBox<string> — redacts everywhere but expose()

// The E2E's KNOWN test marker for the secret the root binds to AUTH_SIGNING_SECRET
// (matched by the value the deploy provisions — see .github/workflows/e2e-deploy.yml
// and scripts/e2e-verify.sh). `secretCheck` below proves the secret round-tripped
// (root envSecret -> pointer row -> boot double-lookup -> SecretBox) by comparing
// `signingKey.expose()` to this marker and returning ONLY a boolean. `.expose()` is
// the sole reader; the value is never rendered or logged (SecretBox redacts). This
// constant is a non-sensitive demonstration marker, not a real credential.
const EXPECTED_SIGNING_SECRET = 'sk_test_ci_storefront_auth';

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
    // True iff the injected secret matches the expected marker — proof it was
    // provisioned and double-looked-up, without ever returning the value.
    secretCheck: async () => ({ ok: signingKey.expose() === EXPECTED_SIGNING_SECRET }),
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
// The RPC cold-start canary (scripts/rpc-cold-start-canary.ts) reads this
// line out of the deployment's boot log to prove a touch was sent before the
// server could answer anything — the same technique
// scripts/cold-start-canary.ts already relies on for the streams module.
// Bun.serve binds synchronously, so logging immediately after it returns
// marks the moment this service is actually ready to accept connections.
// The timestamp is stamped here, in-process, rather than left to the
// platform: unlike @prisma/streams-server (which patches console.log to
// prepend one), Compute's log relay passes plain app stdout through
// unmodified — verified live, an unstamped line arrives with no timestamp
// at all — so a line with no timestamp of its own would be unusable
// evidence for classifyBootEvidence's cross-clock comparison.
console.log(`[${new Date().toISOString()}] [INFO] auth server listening on 0.0.0.0:${port}`);
