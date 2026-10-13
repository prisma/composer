/**
 * Checks that a deployed stage's App, Database and Bucket rows carry the same
 * `logicalId`s as the service and resource nodes of the application topology
 * submitted to that stage's Branch (ADR-0051). Pure, so it is unit-tested;
 * `e2e-verify-identity.ts` feeds it from the Management API.
 */

import type { ApplicationTopologyNodeBody } from '../packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts';

export type RowKind = 'app' | 'database' | 'bucket';

export type TopologyNode = Pick<ApplicationTopologyNodeBody, 'logicalId' | 'kind' | 'type'>;

export interface PlatformRow {
  readonly kind: RowKind;
  readonly id: string;
  readonly branchId: string | null;
  readonly logicalId: string | null;
}

const RESOURCE_ROW_KINDS: Readonly<Record<string, RowKind>> = {
  'raw-postgres': 'database',
  postgres: 'database',
  s3: 'bucket',
};

/** The kind of platform row a topology node lowers to, or `undefined` when it has none (a module, an S3 credentials resource). */
export function rowKindOf(node: TopologyNode): RowKind | undefined {
  if (node.kind === 'service') return 'app';
  if (node.kind === 'resource' && node.type !== undefined) return RESOURCE_ROW_KINDS[node.type];
  return undefined;
}

/** Every mismatch between the topology and the rows on `branchId`; empty when they agree. */
export function identityMismatches(
  nodes: readonly TopologyNode[],
  rows: readonly PlatformRow[],
  branchId: string,
): string[] {
  const onBranch = rows.filter((row) => row.branchId === branchId);
  const problems: string[] = [];
  const expected = new Map<string, RowKind>();

  for (const node of nodes) {
    const kind = rowKindOf(node);
    if (kind === undefined) continue;
    expected.set(node.logicalId, kind);
    const matches = onBranch.filter((row) => row.kind === kind && row.logicalId === node.logicalId);
    if (matches.length !== 1) {
      problems.push(
        `${node.kind} node "${node.logicalId}" should match exactly one ${kind} row on branch ${branchId}; found ${String(matches.length)}`,
      );
    }
  }

  for (const row of onBranch) {
    if (row.logicalId === null) {
      problems.push(`${row.kind} ${row.id} on branch ${branchId} has no logicalId`);
    } else if (expected.get(row.logicalId) !== row.kind) {
      problems.push(
        `${row.kind} ${row.id} on branch ${branchId} has logicalId "${row.logicalId}", but no topology node with that logicalId lowers to a ${row.kind}`,
      );
    }
  }

  return problems;
}
