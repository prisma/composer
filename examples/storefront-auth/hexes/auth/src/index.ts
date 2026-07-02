import { Hono } from "hono";
import type { Context } from "hono";
import { SQL } from "bun";

// A Prisma Postgres direct connection is closed when it goes idle (and when the
// service scales to zero). Bun.SQL surfaces that as an async
// ERR_POSTGRES_CONNECTION_CLOSED with no awaiter, which would otherwise crash the
// process into a 502 restart loop. Keep the process alive; the pool reconnects on
// the next query.
process.on("uncaughtException", (err) => console.error("uncaughtException", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

// One connection, closed client-side once idle (before the server drops it) and
// re-established on demand — resilient to scale-to-zero.
const sql = new SQL({ url, max: 1, idleTimeout: 10 });

const app = new Hono();

async function ping(c: Context) {
  try {
    await sql`SELECT 1`;
    return c.json({ ok: true });
  } catch (err) {
    console.error("db query failed", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
  }
}

app.get("/health", ping);
app.get("/verify", ping);

const port = Number(process.env.PORT ?? 3000);
// Bind all interfaces explicitly — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch });
console.log(`auth listening on 0.0.0.0:${port}`);
