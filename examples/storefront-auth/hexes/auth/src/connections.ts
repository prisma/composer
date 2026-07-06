// App-owned connection definitions; the driver import lives HERE. The
// hydrated client type is inferred from the factory — no phantom declaration.
// One connection, closed client-side once idle (before the server drops it)
// and re-established on demand — resilient to Compute's scale-to-zero.
import { postgres } from "@makerkit/prisma-cloud";
import { SQL } from "bun";

export const database = postgres({ client: ({ url }) => new SQL({ url, max: 1, idleTimeout: 10 }) });
