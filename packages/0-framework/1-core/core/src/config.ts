/**
 * The configuration model. Three components, each owned by exactly one
 * party: nodes DECLARE semantic params (pure data, no platform keys); core
 * builds the typed Config from the graph at deploy (buildConfig, in
 * deploy.ts) and consumes it at boot (hydrate, in hydrate.ts); the target
 * pack owns encoding — serializing that Config to the platform environment
 * and reversing it (see core-model.md § Runtime). Core never stringifies and
 * never touches an environment.
 *
 * Secrets are NOT params — they are their own forwardable slot (ADR-0029, see
 * `secret()`/`envSecret()`/`secrets()` in node.ts). A param is never secret.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Graph, SecretBinding } from './graph-types.ts';
import type { ServiceNode } from './node.ts';

/**
 * A declared config param — pure data: a caller-owned Standard Schema
 * (ADR-0018) plus a few framework facets. The framework carries the schema,
 * infers the value type from it, and validates with it, without ever
 * enumerating permitted shapes. Turning a value into stored config and back is
 * the deploy target's job, not the param's (ADR-0019) — the same split RPC
 * uses: schema on the declaration, wire owned by the mover.
 */
export interface ConfigParam<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly schema: S;
  readonly optional?: boolean;
  readonly default?: StandardSchemaV1.InferOutput<S>;
}

export type Params = Record<string, ConfigParam>;

/** What implementations receive — undefined only for optional params with no default. */
export type Values<P extends Params> = {
  readonly [K in keyof P]: P[K]['optional'] extends true
    ? undefined extends P[K]['default']
      ? StandardSchemaV1.InferOutput<P[K]['schema']> | undefined
      : StandardSchemaV1.InferOutput<P[K]['schema']>
    : StandardSchemaV1.InferOutput<P[K]['schema']>;
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
 * alone, nothing booted, no platform keys. The introspection artifact (values
 * absent). `schema` is a data-only projection of the param's Standard Schema
 * (JSON Schema when the vendor supports the optional conversion, a `{ vendor }`
 * tag otherwise) — never the param's functions. Physical locations are the
 * target pack's business. Secrets are not here — they live on their own slot.
 */
export interface ConfigDeclaration {
  readonly owner: 'service' | { readonly input: string };
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly optional: boolean;
  readonly default: unknown;
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
 * A data-only descriptor of a param's schema for introspection — the
 * validator's vendor tag, never the schema's own `validate`. `configOf`
 * reports it where the old model reported `type: 'string' | 'number'`, so the
 * config surface stays enumerable without leaking a function. Nothing consumes
 * more than the vendor tag yet; a richer projection (e.g. a JSON-Schema export
 * when the vendor offers one) is an additive change if a consumer needs it.
 */
function projectSchema(schema: StandardSchemaV1): Readonly<Record<string, unknown>> {
  return { vendor: schema['~standard'].vendor };
}

/**
 * Enumerates every config param the service declares: each input's connection
 * params, then the service's own params. Pure — reads `root.inputs`/`params`
 * directly, executes nothing but the (also pure) schema projection. Deliberately
 * does not go through `Load`: a service's connection-end inputs are legitimately
 * unwired from its own point of view (wiring is an enclosing module's concern),
 * and this introspects one service's declared shape regardless of how — or
 * whether — it composes into a larger graph.
 */
export function configOf(root: ServiceNode): readonly ConfigDeclaration[] {
  const entries: ConfigDeclaration[] = [];

  for (const [input, value] of Object.entries(root.inputs)) {
    if (typeof value !== 'object' || value === null) continue;
    // Every dependency input declares `connection.params` in the same shape
    // (Connection<Params, C>) — nothing to narrow before reading it.
    for (const [name, param] of Object.entries(value.connection.params)) {
      entries.push({
        owner: { input },
        name,
        schema: projectSchema(param.schema),
        optional: param.optional === true,
        default: param.default,
      });
    }
  }

  for (const [name, param] of Object.entries(root.params)) {
    entries.push({
      owner: 'service',
      name,
      schema: projectSchema(param.schema),
      optional: param.optional === true,
      default: param.default,
    });
  }

  return entries;
}

/**
 * The app's provision manifest: every secret binding the root resolved across
 * the graph (ADR-0029) — an opaque, target-defined source per service secret
 * slot; a deploy target's preflight reads its own payload. Pure graph
 * introspection, TARGET-AGNOSTIC — the target consumes it to verify each secret
 * exists on the platform before deploy. The values are provisioned out-of-band.
 */
export function provisionManifest(graph: Graph): readonly SecretBinding[] {
  return graph.secrets;
}

// ——— Param constructors: plain data, target-agnostic (ADR-0018/0019). ———
//
// A param is just a schema plus facets; serialization is the deploy target's
// (see @prisma/compose-prisma-cloud's serializer.ts), so these constructors carry no
// encoding. `string()`/`number()` supply hand-rolled Standard Schemas for the
// common scalars — core needs no arktype dependency for them — and `param()`
// wraps any caller-supplied schema.

function scalarSchema<T>(
  name: string,
  check: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: '@prisma/compose',
      validate: (value: unknown) =>
        check(value)
          ? { value }
          : { issues: [{ message: `expected ${name}, got ${typeof value}` }] },
    },
  };
}

const stringSchema = scalarSchema<string>('string', (v): v is string => typeof v === 'string');
const numberSchema = scalarSchema<number>(
  'number',
  (v): v is number => typeof v === 'number' && Number.isFinite(v),
);

export interface ParamOptions<T> {
  readonly optional?: boolean;
  readonly default?: T;
}

function withFacets<S extends StandardSchemaV1>(
  schema: S,
  opts: ParamOptions<StandardSchemaV1.InferOutput<S>>,
): ConfigParam<S> {
  return {
    schema,
    ...(opts.optional !== undefined ? { optional: opts.optional } : {}),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

/** A string-valued param. */
export function string(
  opts: ParamOptions<string> = {},
): ConfigParam<StandardSchemaV1<string, string>> {
  return withFacets(stringSchema, opts);
}

/** A number-valued param. */
export function number(
  opts: ParamOptions<number> = {},
): ConfigParam<StandardSchemaV1<number, number>> {
  return withFacets(numberSchema, opts);
}

/** A param over any caller-supplied Standard Schema — a structured `jobs`, say. */
export function param<S extends StandardSchemaV1>(
  schema: S,
  opts: ParamOptions<StandardSchemaV1.InferOutput<S>> = {},
): ConfigParam<S> {
  return withFacets(schema, opts);
}
