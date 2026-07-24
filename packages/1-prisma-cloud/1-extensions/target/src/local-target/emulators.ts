/**
 * Dev emulator bring-up (local-dev spec § 5, ADR-0041 D4): ensures the
 * machine-scoped daemons this topology's node kinds need. Compute is always
 * ensured — every app has services; buckets only when the graph uses the
 * `s3` resource kind; postgres only when the graph uses the `postgres` or
 * `prisma-next` resource kind (REVISED — Postgres is a first-class daemon
 * since the programmatic `@prisma/dev` adoption, operator review of #162).
 *
 * Idempotent: `ensureDaemon` itself adopts an already-healthy daemon, so
 * repeated `prisma-composer dev` sessions are cheap.
 *
 * Entry resolution (spec § 2's publish note): `ensureDaemon` does not
 * resolve its own daemon program — it takes the resolved `entry` path from
 * its caller. This extension resolves against the PUBLIC
 * `@prisma/composer-prisma-cloud/local-target/*-main` subpaths (not the
 * private `@internal/dev-emulators` ones), so a published install's `dev`
 * command finds its daemon programs in its own dependency tree. Resolution
 * itself is delegated to `@internal/local-target` (this extension's own
 * source stays free of `node:`/`bun:` imports — invariant 5).
 */
import type { LocalTargetEmulatorsInput } from '@internal/core/config';
import type { DaemonName } from '@internal/dev-emulators';
import { ensureDaemon } from '@internal/dev-emulators';
import { resolvePackageEntry } from '@internal/local-target';

function usesBuckets(input: LocalTargetEmulatorsInput): boolean {
  return input.graph.nodes.some((n) => n.node.kind === 'resource' && n.node.type === 's3');
}

function usesPostgres(input: LocalTargetEmulatorsInput): boolean {
  return input.graph.nodes.some(
    (n) =>
      n.node.kind === 'resource' && (n.node.type === 'postgres' || n.node.type === 'prisma-next'),
  );
}

/** The resolved absolute path to this daemon's published entrypoint. */
function daemonEntry(name: DaemonName): string {
  return resolvePackageEntry(`@prisma/composer-prisma-cloud/local-target/${name}-main`);
}

export async function runDevEmulators(input: LocalTargetEmulatorsInput): Promise<void> {
  const { url: computeUrl } = await ensureDaemon('compute', daemonEntry('compute'));
  console.log(`[dev] compute emulator ready at ${computeUrl}`);

  if (usesBuckets(input)) {
    const { url: bucketsUrl } = await ensureDaemon('buckets', daemonEntry('buckets'));
    console.log(`[dev] buckets emulator ready at ${bucketsUrl}`);
  }

  if (usesPostgres(input)) {
    const { url: postgresUrl } = await ensureDaemon('postgres', daemonEntry('postgres'));
    console.log(`[dev] postgres emulator ready at ${postgresUrl}`);
  }
}
