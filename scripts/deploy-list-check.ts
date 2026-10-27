/**
 * Checks `deploy list --json` output against what the platform holds for the
 * stage: one entry per topology node, in topology order; the root's ID is the
 * Project's; each service, database and bucket has the ID of the row with its
 * `logicalId`; and a service's URL is its App row's endpoint, over https.
 * Pure, so it is unit-tested; `e2e-verify-deploy-list.ts` feeds it.
 */

import { type PlatformRow, rowKindOf, type TopologyNode } from './platform-identity.ts';

export interface ListedNode {
  readonly address: string;
  readonly kind: string;
  readonly platformId: string | null;
  readonly url: string | null;
}

export interface ListedPlatform {
  readonly projectId: string;
  readonly branchId: string;
  readonly nodes: readonly (TopologyNode & { readonly parentLogicalId: string | null })[];
  readonly rows: readonly PlatformRow[];
}

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const record: Record<string, unknown> = { ...value };
  return record[key];
}

const isListedNode = (value: unknown): value is ListedNode =>
  typeof field(value, 'address') === 'string' &&
  typeof field(value, 'kind') === 'string' &&
  isStringOrNull(field(value, 'platformId')) &&
  isStringOrNull(field(value, 'url'));

/** The nodes in the `result` event `--json` prints last. */
export function parseListed(event: unknown): ListedNode[] {
  const result = field(field(event, 'envelope'), 'result');
  if (!Array.isArray(result) || !result.every(isListedNode)) {
    throw new Error(`deploy list --json printed no list of nodes: ${JSON.stringify(event)}`);
  }
  return result;
}

/** Every way the listing disagrees with the platform; empty when it agrees. */
export function deployListMismatches(
  listed: readonly ListedNode[],
  platform: ListedPlatform,
): string[] {
  const problems: string[] = [];
  const addresses = listed.map((entry) => entry.address);
  const logicalIds = platform.nodes.map((node) => node.logicalId);
  if (addresses.join('\n') !== logicalIds.join('\n')) {
    problems.push(
      `lists [${addresses.join(', ')}], but the topology has [${logicalIds.join(', ')}]`,
    );
  }

  for (const node of platform.nodes) {
    const entry = listed.find((candidate) => candidate.address === node.logicalId);
    if (entry === undefined) continue;
    const kind = rowKindOf(node);
    const row = platform.rows.find(
      (candidate) =>
        candidate.branchId === platform.branchId &&
        candidate.kind === kind &&
        candidate.logicalId === node.logicalId,
    );
    const platformId = node.parentLogicalId === null ? platform.projectId : (row?.id ?? null);
    if (entry.platformId !== platformId) {
      problems.push(
        `${entry.address} lists platform ID ${String(entry.platformId)}, but the platform has ${String(platformId)}`,
      );
    }
    const url = kind === 'app' ? (row?.appEndpointDomain ?? null) : null;
    if (entry.url !== url) {
      problems.push(`${entry.address} lists URL ${String(entry.url)}, but expected ${String(url)}`);
    }
    if (entry.url !== null && !entry.url.startsWith('https://')) {
      problems.push(`${entry.address} lists URL ${entry.url}, which is not https`);
    }
  }
  return problems;
}
