/**
 * The configuration model. Three components, each owned by exactly one
 * party: nodes DECLARE semantic params (pure data, no platform keys); core
 * builds the typed Config from the graph at deploy (buildConfig, in
 * deploy.ts) and consumes it at boot (hydrate, in hydrate.ts); the target
 * pack owns encoding — serializing that Config to the platform environment
 * and reversing it (see core-model.md § Runtime). Core never stringifies and
 * never touches an environment.
 */
import { Load } from './graph.ts';
import type { ResourceNode, ServiceNode } from './node.ts';

/** Runtime-validatable param types. Curated; extended consciously. */
export type ParamType = 'string' | 'number';
export type TypeOf<T extends ParamType> = T extends 'string' ? string : number;

/**
 * A declared config param — pure data. The declaration does double duty:
 * TypeScript derives the hydrate/load input types from it (the definition
 * object ENFORCES the final param input types), and the target pack validates
 * raw values against `type` when it reverses its own serialization at boot.
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
  readonly [K in keyof P]: P[K]['optional'] extends true
    ? undefined extends P[K]['default']
      ? TypeOf<P[K]['type']> | undefined
      : TypeOf<P[K]['type']>
    : TypeOf<P[K]['type']>;
};

/**
 * The connection face of a dependency: declared params (data) and how
 * validated values become a client (the hydrate behavior slot). Both P and C
 * are INFERRED — the declaration types hydrate's input; the factory types the
 * loaded dep.
 */
export interface Connection<P extends Params = Params, C = unknown> {
  readonly params: P;
  hydrate(values: Values<P>): C | Promise<C>;
}

/**
 * The enumerable config surface of a service — derivable from the graph
 * alone, nothing booted, no platform keys. The introspection artifact
 * (secrets marked, values absent). Physical locations are the target pack's
 * business.
 */
export interface ConfigDeclaration {
  readonly owner: 'service' | { readonly input: string };
  readonly name: string;
  readonly type: ParamType;
  readonly secret: boolean;
  readonly optional: boolean;
  readonly default?: string | number;
}

/**
 * The resolved, typed configuration of one service — what crosses the
 * core→pack boundary. Core builds it at deploy (leaf values are provisioning
 * refs, so the env writes depend on the resources/producer — the ordering
 * edges); the pack serializes it, and at boot reconstructs the identical
 * structure with concrete values. Both forms conform to the shape from
 * configOf. Core never stringifies.
 */
export interface Config {
  readonly service: Readonly<Record<string, unknown>>;
  readonly inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Enumerates every config param the service's graph declares: each input's
 * connection params, then the service's own params. Pure — Loads the graph,
 * executes nothing.
 */
export function configOf(root: ServiceNode): readonly ConfigDeclaration[] {
  const graph = Load(root);
  const entries: ConfigDeclaration[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== 'input') continue;
    const entry = graph.nodes.find((n) => n.id === edge.from);
    if (
      entry === undefined ||
      (entry.node.kind !== 'resource' && entry.node.kind !== 'connection')
    ) {
      continue;
    }
    // Resource and connection-end inputs declare params identically.
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
      owner: 'service',
      name,
      type: param.type,
      secret: param.secret === true,
      optional: param.optional === true,
      ...(param.default !== undefined ? { default: param.default } : {}),
    });
  }

  return entries;
}
