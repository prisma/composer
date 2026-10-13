/**
 * The emulators hook's half of the directory's record: before Alchemy runs,
 * every node of the app gets its emulator instance, one at a time in the
 * order given.
 */
import { bucketDataDir } from './bucket.ts';
import {
  type AppScope,
  ensureBucketInstance,
  ensureDatabaseInstance,
  ensureServiceInstance,
  type NodeKind,
  type PortChange,
} from './emulator-instances.ts';
import { resolvePrismaDevModulePath } from './postgres.ts';

export interface AppNode {
  readonly address: string;
  readonly kind: NodeKind;
}

/**
 * Ensures each node's instance, in the order given: a recorded instance is
 * reused (a stopped database is started), a missing one is created again on
 * its remembered port, and a new node gets a new instance. A new instance
 * gets the smallest free port, so on a fresh start the ports follow this
 * order. Returns the nodes whose re-created instance could not get its
 * remembered port back.
 */
export async function ensureAppInstances(
  scope: AppScope,
  nodes: readonly AppNode[],
): Promise<PortChange[]> {
  const changes: PortChange[] = [];
  for (const { address, kind } of nodes) {
    try {
      const { portChange } = await ensureNodeInstance(scope, address, kind);
      if (portChange) changes.push(portChange);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`ensuring the local instance for ${kind} "${address}" failed: ${reason}`, {
        cause,
      });
    }
  }
  return changes;
}

async function ensureNodeInstance(
  scope: AppScope,
  address: string,
  kind: NodeKind,
): Promise<{ readonly portChange?: PortChange }> {
  if (kind === 'service') return ensureServiceInstance(scope, address);
  if (kind === 'database') {
    return ensureDatabaseInstance(scope, address, resolvePrismaDevModulePath());
  }
  await ensureBucketInstance(scope, address, bucketDataDir(scope, address));
  return {};
}
