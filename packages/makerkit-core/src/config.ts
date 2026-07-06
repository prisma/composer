/**
 * The configuration model (core-owned; the boot pipeline lives in
 * runtime.ts). Three components, each owned by exactly one party: nodes
 * DECLARE semantic params (pure data, no platform keys); the service's
 * ConfigAdapter answers GET/SET for its platform (the semantic↔physical
 * mapping is its private business); core does everything in between.
 */
import { Load } from "./graph.ts";
import type { ResourceNode, ServiceNode } from "./node.ts";

/** Runtime-validatable param types. Curated; extended consciously. */
export type ParamType = "string" | "number";
export type TypeOf<T extends ParamType> = T extends "string" ? string : number;

/**
 * A declared config param — pure data. The declaration does double duty: core
 * validates raw values against `type` at boot, and TypeScript derives the
 * hydrate/handler input types from it — the definition object ENFORCES the
 * final param input types.
 */
export interface ConfigParam<T extends ParamType = ParamType> {
  readonly type: T;
  /** Redacted in any introspection output. */
  readonly secret?: boolean;
  readonly optional?: boolean;
  readonly default?: TypeOf<T>;
}

export type Params = Record<string, ConfigParam>;

/** What implementations receive — undefined only for optional params with no default. */
export type Values<P extends Params> = {
  readonly [K in keyof P]: P[K]["optional"] extends true
    ? undefined extends P[K]["default"]
      ? TypeOf<P[K]["type"]> | undefined
      : TypeOf<P[K]["type"]>
    : TypeOf<P[K]["type"]>;
};

/**
 * The connection face of a dependency: declared params (data) and how
 * validated values become a client (the hydrate behavior slot). Both P and C
 * are INFERRED — the declaration types hydrate's input; the factory types the
 * handler's dep.
 */
export interface Connection<P extends Params = Params, C = unknown> {
  readonly params: P;
  hydrate(values: Values<P>): C | Promise<C>;
}

/**
 * The platform's config I/O, pack-provided and attached to the service node
 * by its constructor. The mapping between semantic params and physical
 * locations is the adapter's PRIVATE business — core never sees platform
 * keys. The adapter owns its source: the platform adapter is the one
 * sanctioned environment reader; an in-memory test adapter reads nothing.
 */
export interface ConfigAdapter {
  /** Raw values keyed by request id; core validates/coerces. */
  get(requests: readonly ConfigRequest[]): Promise<Readonly<Record<string, string>>>;
  /** Tests · deploy plane. */
  set?(values: Readonly<Record<string, string>>): Promise<void>;
  /** Ops introspection: "which physical location is this param?" */
  describe?(request: ConfigRequest): Promise<{ location: string }>;
}

export interface ConfigRequest {
  /** Core-assigned; keys the returned value map. */
  readonly id: string;
  readonly owner: "service" | { readonly input: string };
  readonly name: string;
  readonly param: ConfigParam;
}

/**
 * The enumerable config surface of a service — derivable from the graph
 * alone, nothing booted, no platform keys. The introspection artifact
 * (secrets marked, values absent). Physical locations are the adapter's
 * business (describe()).
 */
export interface ConfigManifestEntry {
  readonly owner: "service" | { readonly input: string };
  readonly name: string;
  readonly type: ParamType;
  readonly secret: boolean;
  readonly optional: boolean;
  readonly default?: string | number;
}

/**
 * Enumerates every config param the service's graph declares: each input's
 * connection params, then the service's own params. Pure — Loads the graph,
 * executes nothing.
 */
export function configOf(root: ServiceNode): readonly ConfigManifestEntry[] {
  const graph = Load(root);
  const entries: ConfigManifestEntry[] = [];

  for (const edge of graph.edges) {
    const entry = graph.nodes.find((n) => n.id === edge.from);
    if (entry === undefined || entry.node.kind !== "resource") continue;
    const node = entry.node as ResourceNode;
    for (const [name, param] of Object.entries(node.connection.params)) {
      entries.push({
        owner: { input: edge.input },
        name,
        type: param.type,
        secret: param.secret === true,
        optional: param.optional === true,
        ...(param.default !== undefined ? { default: param.default } : {}),
      });
    }
  }

  for (const [name, param] of Object.entries(root.params)) {
    entries.push({
      owner: "service",
      name,
      type: param.type,
      secret: param.secret === true,
      optional: param.optional === true,
      ...(param.default !== undefined ? { default: param.default } : {}),
    });
  }

  return entries;
}
