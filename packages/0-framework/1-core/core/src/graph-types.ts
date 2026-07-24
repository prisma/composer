import type { DependencyEnd, InputBinding, ModuleNode, ResourceNode, ServiceNode } from './node.ts';

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
 * A service's provision-time input binding (ADR-0042): the plain object a
 * `provision(service, { input })` call supplied, recorded at that service's
 * address. Core never walks it beyond usage tracking; the deploy target's
 * recursive descent classifies its leaves (literals, `envParam`, `envSecret`).
 */
export interface ServiceInputBinding {
  /** The graph address of the service that declares the input schema. */
  readonly serviceAddress: NodeId;
  /** The binding object supplied at provision. */
  readonly binding: InputBinding;
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
  /** Every service input binding a `provision()` call supplied (ADR-0042). */
  readonly inputBindings: readonly ServiceInputBinding[];
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
