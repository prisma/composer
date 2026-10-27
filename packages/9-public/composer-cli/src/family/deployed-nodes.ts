import { type DeployedStage, RESOURCE_ROW_KINDS } from '@internal/lowering/deployed';

/** One row of `deploy list`: a topology node and the platform row it deployed to. */
export interface DeployedNode {
  readonly address: string;
  readonly kind: string;
  readonly platformId: string | null;
  readonly url: string | null;
}

type TopologyNode = DeployedStage['nodes'][number];

function kindOf(node: TopologyNode): string {
  if (node.parentLogicalId === null) return 'project';
  if (node.kind === 'resource') {
    if (node.type === undefined) return 'resource';
    const rowKind = RESOURCE_ROW_KINDS.get(node.type);
    if (rowKind === 'database') return 'postgres';
    return rowKind ?? node.type;
  }
  return node.kind;
}

function rowId(rows: readonly { id: string; logicalId: string | null }[], logicalId: string) {
  return rows.find((row) => row.logicalId === logicalId)?.id ?? null;
}

function deployedNode(stage: DeployedStage, node: TopologyNode): DeployedNode {
  const kind = kindOf(node);
  const address = node.logicalId;
  switch (kind) {
    case 'project':
      return { address, kind, platformId: stage.projectId, url: null };
    case 'service': {
      const row = stage.services.find((service) => service.logicalId === address);
      return {
        address,
        kind,
        platformId: row?.id ?? null,
        url: row?.appEndpointDomain ?? null,
      };
    }
    case 'postgres':
      return { address, kind, platformId: rowId(stage.databases, address), url: null };
    case 'bucket':
      return { address, kind, platformId: rowId(stage.buckets, address), url: null };
    default:
      return { address, kind, platformId: null, url: null };
  }
}

/** Every node of the stage's topology, in topology order, joined by `logicalId` to the platform row it deployed to. The root's row is the Project. */
export function deployedNodes(stage: DeployedStage): DeployedNode[] {
  return stage.nodes.map((node) => deployedNode(stage, node));
}
