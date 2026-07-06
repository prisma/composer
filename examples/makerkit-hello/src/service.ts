import { compute } from "@makerkit/prisma-cloud";
import { database } from "./connections.ts";

/**
 * The authored service: a Compute service with a Postgres dependency. The
 * handler reads nothing from the environment — core's pipeline hydrates `db`
 * (through the connection defined in connections.ts) and resolves `port`.
 */
export default compute({ db: database }, ({ db }, { port }) =>
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: async () => Response.json(await db`select 1 as ok`),
  }),
);
