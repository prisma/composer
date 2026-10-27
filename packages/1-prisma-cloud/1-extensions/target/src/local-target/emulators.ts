/**
 * Dev emulator bring-up (local-dev spec § 5, ADR-0041 D4): ensures the
 * machine-scoped daemons this topology's node kinds need. Compute is always
 * ensured — every app has services; buckets only when the graph uses the
 * `s3` resource kind; postgres only when the graph uses the `raw-postgres` or
 * `postgres` resource kind (REVISED — Postgres is a first-class daemon
 * since the programmatic `@prisma/dev` adoption, operator review of #162).
 *
 * Once the daemons are up, the app becomes the directory's current app (a
 * different app run here before has its services and databases stopped,
 * data kept), and every node's instance is ensured through the directory's
 * record in graph order: services, databases and buckets. A fresh start thus
 * numbers ports dependencies first, which Alchemy's concurrent applies would
 * otherwise do in arrival order, and a recorded database stopped by the last
 * session is started before converge, which on a warm start may never call
 * the Database provider at all.
 *
 * Idempotent: `ensureDaemon` itself adopts an already-healthy daemon, so
 * repeated `prisma dev` sessions are cheap.
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
import { ensureDaemon } from '@internal/dev-emulators';
import {
  type AppNode,
  appNameOf,
  ensureAppInstances,
  selectApp,
  stopAppInstances,
} from '@internal/local-target';
import { RESOURCE_ROW_KINDS } from '@internal/lowering/deployed';
import { PRISMA_CLOUD_EXTENSION_ID } from '../container.ts';
import { resourceId } from '../resource-ids.ts';
import { daemonEntry } from './daemon-entry.ts';

/**
 * This extension's nodes that run on an emulator, in `graph.nodes` order —
 * dependencies first, ties in declaration order — keyed by their main
 * resource's ID, the key the local providers look each one up by.
 */
function appNodes(input: LocalTargetEmulatorsInput): AppNode[] {
  return input.graph.nodes.flatMap((n): AppNode[] => {
    if (n.node.kind === 'service' && n.node.extension === PRISMA_CLOUD_EXTENSION_ID) {
      return [{ address: resourceId(n.id), kind: 'service' }];
    }
    const rowKind = n.node.kind === 'resource' ? RESOURCE_ROW_KINDS.get(n.node.type) : undefined;
    if (rowKind !== undefined) return [{ address: resourceId(n.id), kind: rowKind }];
    return [];
  });
}

export async function runDevEmulators(input: LocalTargetEmulatorsInput): Promise<void> {
  const nodes = appNodes(input);
  const { url: computeUrl } = await ensureDaemon('compute', daemonEntry('compute'));
  console.log(`[dev] compute emulator ready at ${computeUrl}`);
  if (nodes.some((node) => node.kind === 'bucket')) {
    const { url: bucketsUrl } = await ensureDaemon('buckets', daemonEntry('buckets'));
    console.log(`[dev] buckets emulator ready at ${bucketsUrl}`);
  }
  if (nodes.some((node) => node.kind === 'database')) {
    const { url: postgresUrl } = await ensureDaemon('postgres', daemonEntry('postgres'));
    console.log(`[dev] postgres emulator ready at ${postgresUrl}`);
  }

  const scope = { devDir: input.devDir, app: appNameOf(input.container) };
  const previous = await selectApp(scope);
  if (previous !== undefined) {
    console.log(
      `[dev] stopped the local services of "${previous}", the app run here before; its data is kept`,
    );
  }
  const portChanges = await ensureAppInstances(scope, nodes).catch(async (error: unknown) => {
    // `dev` fails here without a session to end, so stop the app's whole
    // recorded set, as Ctrl-C would, then report the failure. One directory
    // runs one `dev` session at a time.
    await stopAppInstances(scope).catch(() => undefined);
    throw error;
  });
  for (const { kind, address, previous: before, given } of portChanges) {
    console.log(
      `[dev] ${kind} "${address}" now uses port ${String(given)}: its previous port ${String(before)} is in use`,
    );
  }
}
