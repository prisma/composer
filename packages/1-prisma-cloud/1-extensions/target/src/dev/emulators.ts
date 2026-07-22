/**
 * Dev emulator bring-up (local-dev spec § 5, ADR-0041 D4): ensures the
 * machine-scoped daemons this topology's node kinds need. Compute is always
 * ensured — every app has services; buckets only when the graph actually
 * uses the `s3` resource kind. Postgres needs no pre-start — its instances
 * are created lazily by `Database`'s local provider through the ORM CLI.
 *
 * Idempotent: `ensureDaemon` itself adopts an already-healthy daemon, so
 * repeated `prisma-composer dev` sessions are cheap.
 */
import type { DevEmulatorsInput } from '@internal/core/config';
import { ensureDaemon } from '@internal/dev-emulators';

function usesBuckets(input: DevEmulatorsInput): boolean {
  return input.graph.nodes.some((n) => n.node.kind === 'resource' && n.node.type === 's3');
}

export async function runDevEmulators(input: DevEmulatorsInput): Promise<void> {
  const { url: computeUrl } = await ensureDaemon('compute');
  console.log(`[dev] compute emulator ready at ${computeUrl}`);

  if (usesBuckets(input)) {
    const { url: bucketsUrl } = await ensureDaemon('buckets');
    console.log(`[dev] buckets emulator ready at ${bucketsUrl}`);
  }
}
