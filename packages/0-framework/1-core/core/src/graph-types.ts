import type { DependencyEnd, ModuleNode, ResourceNode, ServiceNode } from './node.ts';

/** Path-derived: root-scope children are bare ids ("auth", "db"); a nested module's own children dot-join under its address ("auth.db"). */
export type NodeId = string;

export interface GraphNode {
  readonly id: NodeId;
  readonly node: ServiceNode | ResourceNode | DependencyEnd | ModuleNode;
}

/**
 * `input`: a service consumes its own declared dependency slot — from the
 * slot node to the service. `dependency`: a service consumes a provisioned
 * producer (a service or a resource — the one wiring mechanism) — from the
 * producer to the consumer, labeled with the consumer's input name (from the
 * module wiring).
 */
export interface Edge {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly input: string;
  readonly kind: 'input' | 'dependency';
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
    this.name = 'LoadError';
  }
}
