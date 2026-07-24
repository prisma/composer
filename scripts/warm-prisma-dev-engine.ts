/**
 * Warms the machine-global `@prisma/dev` engine cache before the integration
 * proofs run. `@prisma/dev` downloads its database-engine binaries on their
 * first-ever use on a machine; a CI runner starts genuinely cold every time.
 * Isolating that one-time download in its own step gives it a clear,
 * attributable failure (network egress to the engine host, disk space, …)
 * instead of surfacing buried inside a five-service `alchemy deploy` three
 * provider frames deep.
 *
 * This uses the SAME programmatic entry point the proofs' postgres-main
 * daemon uses — `startPrismaDevServer` — and never the `prisma dev` CLI. The
 * CLI dynamically fetches its own subcommand from the network at runtime, a
 * surface we don't ship against and can't pin: an upstream break in that
 * fetched subcommand once turned this warmup (and every PR's Test job) red
 * with no change on our side. The programmatic API is the contract we depend
 * on, so it is the contract we warm.
 */
import { startPrismaDevServer } from '@prisma/dev';
import { deleteServer } from '@prisma/dev/internal/state';

const NAME = 'ci-engine-warmup';

const server = await startPrismaDevServer({ name: NAME, persistenceMode: 'stateful' });
await server.close();
// The instance is disposable — only its download populated the shared cache.
await deleteServer(NAME).catch(() => undefined);

console.log('prisma dev engine cache warmed via startPrismaDevServer');
