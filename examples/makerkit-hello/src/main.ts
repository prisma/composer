// Runtime bundle entry (app-owned): the driver import lives HERE — the app
// picks Bun's SQL client for a platform whose runtime is Bun. max/idleTimeout
// keep the pool resilient to Compute's scale-to-zero (the server drops idle
// connections; close client-side first and reconnect on demand).
import { runHost } from "@makerkit/core/runtime";
import { runtime } from "@makerkit/prisma-cloud/runtime";
import { SQL } from "bun";
import service from "./service.ts";

runHost(
  service,
  runtime({ clients: { postgres: ({ url }) => new SQL({ url, max: 1, idleTimeout: 10 }) } }),
);
