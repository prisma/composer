import { CliStructuredError } from '@internal/foundation/errors';
import type { ContractStyle } from './contract.ts';
import type {
  DependencyEnd,
  InputBinding,
  ModuleNode,
  ResourceNode,
  SecretSource,
  ServiceNode,
} from './node.ts';
import type { EnvironmentRealValues } from './value.ts';

/** Path-derived: root-scope children are bare ids ("auth", "db"); a nested module's own children dot-join under its address ("auth.db"). */
export type NodeId = string;

export interface LoadOptions {
  /** The root's address: the app name. Defaults to the root's `name`. */
  readonly id?: NodeId;
  /** The facts of the environment being loaded. `name` is what `--environment` gave. Required by any value over `environment.name`. */
  readonly environment?: EnvironmentRealValues;
  /** The config pool: the values a source with a pool key, such as `envParam('NAME')`, reads by name at deploy, and the root's input. Required by any such source whose real value Load needs, and by a root that declares input. The deploy and dev commands pass what the `config` adapters return. */
  readonly configPool?: Readonly<Record<string, unknown>>;
}

export interface GraphNode {
  readonly id: NodeId;
  /**
   * The containing node's id — `undefined` only on the root. Carried
   * explicitly because containment is STATED, never derived: the dots in an
   * address are a readable-uniqueness convention, and anything downstream
   * (the platform's application topology included) treats the id as opaque.
   */
  readonly parent: NodeId | undefined;
  readonly node: ServiceNode | ResourceNode | DependencyEnd | ModuleNode;
}

/** The reserved name of a resource's single anonymous output port. Rejected as a user-declared port name (node.ts). */
export const RESOURCE_OUT_PORT = '$out';

/** One end of an authored edge: a boundary port named by its owning node, direction, and name. */
export interface PortEndpoint {
  readonly node: NodeId;
  readonly direction: 'in' | 'out';
  readonly name: string;
}

/**
 * A declared boundary port: a module's dep/expose entry, a service's
 * input/expose entry, or a resource's one anonymous output (`$out`).
 * `contractKind` is the protocol brand riding the port — a DependencyEnd's
 * `type` on an `in` port, the exposed Contract's `kind` on an `out` port.
 * `style` is the exposed Contract's declared style; `in` ports carry none.
 */
export interface BoundaryPort extends PortEndpoint {
  readonly contractKind: string | undefined;
  readonly style: ContractStyle | undefined;
}

/**
 * A pre-dereference edge, exactly as authored: module boundaries are
 * ordinary edges (an input forwarded into a child is module-`in` →
 * child-`in`; a child's output exposed by its module is child-`out` →
 * module-`out`; a re-exposed own input is `in` → `out` on the same module),
 * where the flat `edges` view resolves every forwarding chain through to the
 * real producer. A wiring whose source names no port (a whole ref wired
 * wholesale into an untyped slot) authors no edge here.
 */
export interface AuthoredEdge {
  readonly from: PortEndpoint;
  readonly to: PortEndpoint;
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

/** A secret source the graph names, in a binding or as a resolve() dependency, wherever it sits (ADR-0029). Deploy preflight checks every one, so the platform variables an app needs do not depend on which pointer a resolve() function returns. */
export interface SecretSourceUse {
  /** The source, as its target built it. Core never reads its payload. */
  readonly source: SecretSource;
  /** A service whose final binding holds it, if one does. Otherwise the first node whose binding names it, directly or through a resolve() dependency: a module whose input holds it, or a resource whose props list it in a resolve(). */
  readonly address: NodeId;
  /** That node's kind. */
  readonly nodeKind: 'service' | 'module' | 'resource';
}

export interface Graph {
  readonly root: GraphNode;
  /** Root + one per input, topo-ordered (deps first). */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly Edge[];
  /** Every declared boundary port, in declaration order. */
  readonly ports: readonly BoundaryPort[];
  /** The authored (pre-dereference) edges between boundary ports, in declaration order. */
  readonly authoredEdges: readonly AuthoredEdge[];
  /** Every service input binding a `provision()` call supplied (ADR-0042). */
  readonly inputBindings: readonly ServiceInputBinding[];
  /** Every service param bound at provision — literal or source; unbound params are absent here and fall back to their `default` (see `buildConfig`). */
  readonly params: readonly ParamBinding[];
  /** Every secret source a binding or a resolve() dependency names, once each, in the order Load met them (ADR-0029). */
  readonly secretSources: readonly SecretSourceUse[];
}

/**
 * Thrown by Load when the graph is malformed. Structured at origin
 * (base-type rule 6): one type-level code covers every raise site until a
 * finer per-site taxonomy is carved out. The `name` stays
 * `CliStructuredError` — structural recognition depends on it.
 */
export class LoadError extends CliStructuredError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('COMPOSE.GRAPH_INVALID', message, options);
  }
}
