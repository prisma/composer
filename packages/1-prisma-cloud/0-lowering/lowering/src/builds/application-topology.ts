/**
 * The application-topology submission (pdp-control-plane
 * `projects/branch-topology/spec.md`): composes the wire body from the
 * authored view Load keeps on the Graph, hashes it, and PUTs it to the
 * Branch. Best-effort like every report in this package — a refused or
 * unreachable platform costs a warning, never the deploy, and the platform
 * keeps the Branch's previous topology.
 *
 * Everything on the wire is identified by LOGICAL id — the node's address in
 * the declaration. Row ids are recreated on every deploy and never appear.
 * `kind` is the platform's structural enum; `type`, `contractKind`, `style`,
 * and `family` values are this tool's vocabulary, stored uninterpreted.
 */
import { createHash } from 'node:crypto';
import type { AuthoredEdge, ContractStyle, Graph, PortEndpoint } from '@internal/core';
import type { ManagementApiClient } from '../client.ts';

export interface ApplicationTopologyNodeBody {
  readonly logicalId: string;
  /** Required and NULLABLE on the wire: a root states `null`, everything else its containing node. Containment is stated, never derived from the dotted id. */
  readonly parentLogicalId: string | null;
  readonly kind: 'module' | 'service' | 'resource';
  readonly type?: string;
}

export interface ApplicationTopologyPortBody {
  /** The OWNING node's logical id. */
  readonly logicalId: string;
  /** `in` is a dependency of the node, `out` an interface it exposes (ADR-0063). */
  readonly direction: 'in' | 'out';
  readonly name: string;
  readonly contractKind?: string;
}

export interface ApplicationTopologyEndpointBody {
  readonly logicalId: string;
  readonly direction: 'in' | 'out';
  readonly name: string;
}

export interface ApplicationTopologyEdgeBody {
  readonly from: ApplicationTopologyEndpointBody;
  readonly to: ApplicationTopologyEndpointBody;
  readonly family: 'communication' | 'data';
  readonly style?: string;
}

/** The PUT body minus `contentHash` — what the hash below is computed over. */
export interface ApplicationTopologyBody {
  readonly nodes: readonly ApplicationTopologyNodeBody[];
  readonly ports: readonly ApplicationTopologyPortBody[];
  readonly edges: readonly ApplicationTopologyEdgeBody[];
}

/** A map keyed by a port endpoint's node, direction and name. */
class EndpointMap<V> {
  readonly #byNode = new Map<string, Map<PortEndpoint['direction'], Map<string, V>>>();

  set(endpoint: PortEndpoint, value: V): void {
    let byDirection = this.#byNode.get(endpoint.node);
    if (byDirection === undefined) {
      byDirection = new Map();
      this.#byNode.set(endpoint.node, byDirection);
    }
    let byName = byDirection.get(endpoint.direction);
    if (byName === undefined) {
      byName = new Map();
      byDirection.set(endpoint.direction, byName);
    }
    byName.set(endpoint.name, value);
  }

  get(endpoint: PortEndpoint): V | undefined {
    return this.#byNode.get(endpoint.node)?.get(endpoint.direction)?.get(endpoint.name);
  }

  has(endpoint: PortEndpoint): boolean {
    return this.#byNode.get(endpoint.node)?.get(endpoint.direction)?.has(endpoint.name) ?? false;
  }
}

const endpointBody = (endpoint: PortEndpoint): ApplicationTopologyEndpointBody => ({
  logicalId: endpoint.node,
  direction: endpoint.direction,
  name: endpoint.name,
});

/**
 * Composes the wire body from the Graph's authored view. Flat-view
 * dependency-slot nodes are the ports' flat representation and stay off the
 * wire; every module/service/resource node goes on it, with its stated
 * parent. An edge's `family` comes from the spec's resolution walk done
 * client-side: follow the source endpoint through module boundaries (a
 * module port's own one incoming edge) until a service or resource —
 * `data` when the producer is a resource, `communication` otherwise, styled
 * with the style the producing port's contract declares.
 */
export function composeApplicationTopology(graph: Graph): ApplicationTopologyBody {
  const kinds = new Map<string, 'module' | 'service' | 'resource'>();
  const nodes: ApplicationTopologyNodeBody[] = [];
  for (const entry of graph.nodes) {
    const node = entry.node;
    if (node.kind !== 'module' && node.kind !== 'service' && node.kind !== 'resource') continue;
    kinds.set(entry.id, node.kind);
    nodes.push({
      logicalId: entry.id,
      parentLogicalId: entry.parent ?? null,
      kind: node.kind,
      ...(node.kind === 'module' ? {} : { type: node.type }),
    });
  }

  const ports: ApplicationTopologyPortBody[] = graph.ports.map((port) => ({
    logicalId: port.node,
    direction: port.direction,
    name: port.name,
    ...(port.contractKind !== undefined ? { contractKind: port.contractKind } : {}),
  }));

  const incoming = new EndpointMap<AuthoredEdge>();
  for (const edge of graph.authoredEdges) incoming.set(edge.to, edge);
  const styleByPort = new EndpointMap<ContractStyle | undefined>();
  for (const port of graph.ports) styleByPort.set(port, port.style);

  const resolveProducer = (from: PortEndpoint): PortEndpoint | undefined => {
    let current = from;
    const seen = new EndpointMap<true>();
    while (kinds.get(current.node) === 'module') {
      if (seen.has(current)) return undefined;
      seen.set(current, true);
      const feeding = incoming.get(current);
      if (feeding === undefined) return undefined;
      current = feeding.from;
    }
    return current;
  };

  const edges: ApplicationTopologyEdgeBody[] = graph.authoredEdges.map((edge) => {
    const producer = resolveProducer(edge.from);
    const style = producer === undefined ? undefined : styleByPort.get(producer);
    return {
      from: endpointBody(edge.from),
      to: endpointBody(edge.to),
      family:
        producer !== undefined && kinds.get(producer.node) === 'resource'
          ? 'data'
          : 'communication',
      ...(style !== undefined ? { style } : {}),
    };
  });

  return { nodes, ports, edges };
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The content hash the platform stores opaquely: sha256 over a canonical
 * JSON form — entries sorted, keys in a fixed order, absent optionals
 * omitted — so the same declared graph always hashes the same whatever
 * order Load emitted it in. The Build Run records the same value
 * (`applicationTopologyContentHash`), and equal hashes are how the platform
 * links a run to the graph it deployed — a value match, never a row
 * reference.
 */
export function applicationTopologyContentHash(topology: ApplicationTopologyBody): string {
  const canonical = {
    nodes: topology.nodes
      .map((node) => ({
        logicalId: node.logicalId,
        parentLogicalId: node.parentLogicalId,
        kind: node.kind,
        ...(node.type !== undefined ? { type: node.type } : {}),
      }))
      .sort((a, b) => compareStrings(a.logicalId, b.logicalId)),
    ports: topology.ports
      .map((port) => ({
        logicalId: port.logicalId,
        direction: port.direction,
        name: port.name,
        ...(port.contractKind !== undefined ? { contractKind: port.contractKind } : {}),
      }))
      .sort(
        (a, b) =>
          compareStrings(a.logicalId, b.logicalId) ||
          compareStrings(a.direction, b.direction) ||
          compareStrings(a.name, b.name),
      ),
    edges: topology.edges
      .map((edge) => ({
        from: {
          logicalId: edge.from.logicalId,
          direction: edge.from.direction,
          name: edge.from.name,
        },
        to: { logicalId: edge.to.logicalId, direction: edge.to.direction, name: edge.to.name },
        family: edge.family,
        ...(edge.style !== undefined ? { style: edge.style } : {}),
      }))
      // A consuming endpoint takes exactly one edge, so the `to` triple alone orders totally.
      .sort(
        (a, b) =>
          compareStrings(a.to.logicalId, b.to.logicalId) ||
          compareStrings(a.to.direction, b.to.direction) ||
          compareStrings(a.to.name, b.to.name),
      ),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

export interface ApplicationTopologyApi {
  /** Atomically replaces the Branch's whole topology. `true` when the write landed. */
  replace(
    projectId: string,
    branchId: string,
    submission: ApplicationTopologyBody & { readonly contentHash: string },
  ): Promise<boolean>;
}

export interface ApplicationTopologyApiOptions {
  readonly client: ManagementApiClient;
  readonly warn: (message: string) => void;
}

/** Same deadline as the build reports (api.ts): reporting is observability, so no call may stall the deploy. */
const REPORT_DEADLINE_MS = 10_000;

export function applicationTopologyApi(
  options: ApplicationTopologyApiOptions,
): ApplicationTopologyApi {
  const { client, warn } = options;
  return {
    async replace(projectId, branchId, submission) {
      const describe = "record this deploy's application topology";
      let result: { readonly error?: unknown; readonly response: Response };
      try {
        result = await client.PUT(
          '/v1/projects/{projectId}/branches/{branchId}/application-topology',
          {
            params: { path: { projectId, branchId } },
            body: {
              contentHash: submission.contentHash,
              nodes: [...submission.nodes],
              ports: [...submission.ports],
              edges: [...submission.edges],
            },
            signal: AbortSignal.timeout(REPORT_DEADLINE_MS),
          },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warn(`Could not reach Prisma Cloud to ${describe}: ${detail}`);
        return false;
      }
      if (!result.response.ok) {
        const detail = result.error === undefined ? '' : `: ${JSON.stringify(result.error)}`;
        warn(
          `Prisma Cloud refused to ${describe} (HTTP ${String(result.response.status)})${detail}`,
        );
        return false;
      }
      return true;
    },
  };
}
