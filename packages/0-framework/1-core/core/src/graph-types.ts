import type { DependencyEnd, ModuleNode, ResourceNode, SecretSource, ServiceNode } from './node.ts';

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

/**
 * A resolved secret binding: the root bound a service's secret slot to an
 * opaque, target-defined source, and the wiring forwarded it to that service's
 * address (ADR-0029). Core never inspects the source; the deploy target reads
 * its own payload. A target's serializer keys the pointer row off this; the
 * preflight manifest aggregates the sources.
 */
export interface SecretBinding {
  /** The graph address of the service that declares the secret slot. */
  readonly serviceAddress: NodeId;
  /** The secret slot key on that service. */
  readonly slot: string;
  /** The opaque source the root bound the slot to. Core never inspects it; the deploy target reads back its own payload. */
  readonly source: SecretSource;
}

/**
 * A resolved param binding: a `provision()` call bound a service's param
 * slot to either a literal value or an opaque `ParamSource` — the non-secret
 * sibling of `SecretBinding`. Unlike a secret, a param binding is not
 * required for every declared param (a param may fall back to its own
 * `default`), so this list only carries the ones a `provision()` call
 * actually bound.
 */
export interface ParamBinding {
  /** The graph address of the service that declares the param. */
  readonly serviceAddress: NodeId;
  /** The param name on that service. */
  readonly slot: string;
  /** A literal value (schema-validated by `buildConfig`) or an opaque `ParamSource` (the deploy target reads its own payload back) — check with `isParamSource`. Core never inspects a `ParamSource`'s payload. */
  readonly binding: unknown;
}

export interface Graph {
  readonly root: GraphNode;
  /** Root + one per input, topo-ordered (deps first). */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly Edge[];
  /** Every service secret slot resolved to its root-bound opaque source. */
  readonly secrets: readonly SecretBinding[];
  /** Every service param bound at provision — literal or source; unbound params are absent here and fall back to their `default` (see `buildConfig`). */
  readonly params: readonly ParamBinding[];
}

/** Thrown by Load when the graph is malformed. */
export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}
