import { CliStructuredError } from '@internal/foundation/errors';
import type { ContractStyle } from './contract.ts';
import type {
  AppRootNode,
  DependencyEnd,
  ModuleNode,
  ResourceNode,
  SecretSource,
  ServiceNode,
} from './node.ts';
import type { EnvironmentRealValues } from './value.ts';

/** Path-derived: root-scope children are bare ids ("auth", "db"); a nested module's own children dot-join under its address ("auth.db"). */
export type NodeId = string;

/** One field of the root's input that its body names, with the real value the root's schema produced there. */
export interface RootInputField {
  /** The key path inside the root's input, such as `['smtp', 'host']`. */
  readonly path: readonly string[];
  /** The real value; absent when it is `undefined`. */
  readonly value?: unknown;
}

/**
 * What a Load read from the app configuration (ADR-0062). A later Load takes it in place of the
 * app configuration: `lower()` under `deploy` and `destroy` (on the main thread) and `prisma dev`
 * (in its converge worker thread).
 */
export interface AppConfigurationRead {
  /** Each field of the root's input that its body names, as the root's schema produced it. Empty when the root declares no input. */
  readonly rootInput: readonly RootInputField[];
}

interface CommonLoadOptions {
  /** The root's address: the app name. Defaults to the root's `name`. */
  readonly id?: NodeId;
  /** The facts of the environment being loaded. `name` is what `--environment` gave. Required by any value over `environment.name`. */
  readonly environment?: EnvironmentRealValues;
}

/** Load's options in the Load that reads the app configuration: the first Load of a command. */
export interface LoadOptionsWithConfiguration extends CommonLoadOptions {
  /** The app configuration (ADR-0062): what the `config` adapters return. It is the root's input, which the root's schema checks. */
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly appConfigurationRead?: never;
}

/** Load's options in a Load that is given what an earlier Load of the same app read. */
export interface LoadOptionsWithAppConfigurationRead extends CommonLoadOptions {
  readonly configuration?: never;
  /** What the earlier Load read. Load takes each root field from it without running the root's schema. */
  readonly appConfigurationRead: AppConfigurationRead;
}

export type LoadOptions = LoadOptionsWithConfiguration | LoadOptionsWithAppConfigurationRead;

export interface GraphNode {
  readonly id: NodeId;
  /**
   * The containing node's id — `undefined` only on the root. Carried
   * explicitly because containment is STATED, never derived: the dots in an
   * address are a readable-uniqueness convention, and anything downstream
   * (the platform's application topology included) treats the id as opaque.
   */
  readonly parent: NodeId | undefined;
  readonly node: ServiceNode | ResourceNode | DependencyEnd | ModuleNode | AppRootNode;
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
 * The binding a `provision()` call supplied as a service's input (ADR-0042),
 * recorded at the service's address. The deploy target resolves its leaves.
 */
export interface InputBindingUse {
  /** The graph address of the service that declares the input schema. */
  readonly serviceAddress: NodeId;
  /** The binding object supplied at provision. */
  readonly binding: unknown;
}

export interface ParamBinding {
  /** The graph address of the service that declares the param. */
  readonly serviceAddress: NodeId;
  /** The param name on that service. */
  readonly slot: string;
  /** A literal value, schema-validated by `buildConfig`. */
  readonly binding: unknown;
}

/** A secret source a binding in the graph names, or a secret value resource, wherever it sits (ADR-0029). Deploy preflight checks every one, including one in a module's input that no service receives. */
export interface SecretSourceUse {
  /** The source, as its target built it. Core never reads its payload. */
  readonly source: SecretSource;
  /** A service whose final binding holds it, if one does. Otherwise the secret value resource itself, or the module whose input holds it. */
  readonly address: NodeId;
  /** That node's kind. */
  readonly nodeKind: 'service' | 'module' | 'resource';
}

/** One service reading one value resource's value. */
export interface ValueRead {
  /** The service whose resolved binding holds the value. */
  readonly reader: NodeId;
  /** The address of the value resource. */
  readonly resource: NodeId;
  /** The dotted key path in the service's input binding; `''` for the whole binding. */
  readonly path: string;
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
  readonly inputBindings: readonly InputBindingUse[];
  /** Every service param bound at provision; unbound params are absent here and fall back to their `default` (see `buildConfig`). */
  readonly params: readonly ParamBinding[];
  /** Every secret source a binding names, and every secret value resource, once each (ADR-0029). */
  readonly secretSources: readonly SecretSourceUse[];
  /** Each service that reads a value resource's value, and where in its binding it reads it. */
  readonly valueReads: readonly ValueRead[];
  /** What this Load read from the app configuration (ADR-0062). Empty when Load was given none. */
  readonly appConfigurationRead: AppConfigurationRead;
}

/**
 * Thrown by Load when the graph is malformed. Structured at origin
 * (base-type rule 6) under one type-level code. Not every error Load throws
 * is one: a Load that needs a root input field an earlier Load did not read
 * throws an error whose name is the value of `ROOT_INPUT_UNREAD_ERROR`. The `name` stays
 * `CliStructuredError` — structural recognition depends on it.
 */
export class LoadError extends CliStructuredError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('COMPOSE.GRAPH_INVALID', message, options);
  }
}

/** What an extension's `checkGraph` throws to refuse a graph it cannot deploy. Any other throw from the hook is a bug (ADR-0044). The CLI adds the refusing extension's id as `meta.extension`. */
export class GraphCheckError extends CliStructuredError {
  constructor(message: string, options?: { readonly extension?: string }) {
    super(
      'COMPOSE.GRAPH_INVALID',
      message,
      options?.extension === undefined ? undefined : { meta: { extension: options.extension } },
    );
  }
}
