import { compute } from '@makerkit/prisma-cloud';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { database } from './connections.ts';

/**
 * The auth service: a Compute service with a Postgres dependency. The handler
 * reads nothing from the environment — core's pipeline hydrates `db` (through
 * the connection defined in connections.ts) and resolves `port`.
 */
export default compute({ db: database }, ({ db }, { port }) => {
  const app = new Hono();

  // Prove the DB is reachable; map a failed query to 503 so the platform sees
  // an unhealthy (not crashed) service.
  const ping = async (c: Context) => {
    try {
      await db`SELECT 1`;
      return c.json({ ok: true });
    } catch (err) {
      console.error('db query failed', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  };

  app.get('/health', ping);
  app.get('/verify', ping);

  // Bind all interfaces — Compute routes external HTTP to the VM, so a
  // loopback-only listener would be unreachable.
  return Bun.serve({ port, hostname: '0.0.0.0', fetch: app.fetch });
});
