import { compute, postgres } from "@makerkit/prisma-cloud";
import type { SQL } from "bun"; // the APP's choice of client — type-only here

/**
 * The authored service: a Compute service with a Postgres dependency. The
 * handler reads nothing from the environment — the host hydrates `db` (via
 * the app-supplied client factory in main.ts) and resolves `port`.
 */
export default compute({ db: postgres<SQL>() }, ({ db }, { port }) =>
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: async () => Response.json(await db`select 1 as ok`),
  }),
);
