import { isNode, type ResourceNode, type ServiceNode } from "./node.ts";

/** Path-derived: root "hello", its input "hello.db". */
export type NodeId = string;

export interface GraphNode {
  readonly id: NodeId;
  readonly node: ServiceNode | ResourceNode;
}

/** Resource → service, labeled with the input name. */
export interface Edge {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly input: string;
}

export interface Graph {
  readonly root: GraphNode;
  /** Root + one per input, topo-ordered (deps first). */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly Edge[];
}

/** Thrown by Load when the graph is malformed. */
export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadError";
  }
}

/**
 * Walks `root.inputs`, assigns ids, builds edges, and validates: the root is
 * a branded service node; every input value is a branded resource node with a
 * non-empty type. Executes nothing — the graph is data in memory to inspect
 * or hand to lower/runHost.
 */
export function Load(root: ServiceNode, opts?: { id?: NodeId }): Graph {
  if (!isNode(root) || root.kind !== "service") {
    throw new LoadError("Load expects a branded service node (construct it with the service() factory).");
  }
  if (typeof root.inputs !== "object" || root.inputs === null) {
    throw new LoadError("Service node has no inputs map.");
  }

  const rootId = opts?.id ?? "root";
  const rootGraphNode: GraphNode = { id: rootId, node: root };

  const inputNodes: GraphNode[] = [];
  const edges: Edge[] = [];

  for (const [input, value] of Object.entries(root.inputs)) {
    if (!isNode(value) || value.kind !== "resource") {
      throw new LoadError(
        `Input "${input}" is not a branded resource node (construct it with the resource() factory).`,
      );
    }
    if (value.type.length === 0) {
      throw new LoadError(`Input "${input}" has an empty node type.`);
    }
    const id = `${rootId}.${input}`;
    inputNodes.push({ id, node: value });
    edges.push({ from: id, to: rootId, input });
  }

  return {
    root: rootGraphNode,
    nodes: [...inputNodes, rootGraphNode],
    edges,
  };
}
