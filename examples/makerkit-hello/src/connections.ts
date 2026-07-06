// App-owned connection definitions; the driver import lives HERE. The
// hydrated client type is inferred from the factory — no phantom declaration.
// max/idleTimeout keep the pool resilient to Compute's scale-to-zero.
import { postgres } from "@makerkit/prisma-cloud";
import { SQL } from "bun";

export const database = postgres({ client: ({ url }) => new SQL({ url, max: 1, idleTimeout: 10 }) });
