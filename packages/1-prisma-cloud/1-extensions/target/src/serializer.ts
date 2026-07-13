/**
 * The extension's config serializer — the semantic↔physical mapping, private to
 * the extension, SHARED by run() (boot) and /control's serialize (deploy) so writer
 * and reader cannot drift.
 *
 * Keys are unique per service within the shared project namespace: the
 * serializer prefixes them with the deployment address (its segments after the app
 * root — empty for a lone-service deploy, the "unprefixed" case), then the
 * owner (the input name, dropped for the service's own params), then the
 * param name. auth's db.url ↔ AUTH_DB_URL; a lone service's db.url ↔ DB_URL.
 * The platform's DATABASE_URL is never among them — forbidden and poisoned
 * at project provision (see docs/design/05-prisma-cloud/alchemy-lowering.md).
 *
 * This module works off the node's RAW params (`node.params` and each
 * `node.inputs[k].connection.params`) rather than `configOf`'s pure-data
 * projection — it needs each param's `schema` to validate on the way in.
 *
 * Serialization is the target's, not the param's (ADR-0019). The rule is by
 * owner: a service's own params are literals, JSON-encoded; a dependency
 * input's params are provisioning refs at deploy (resolved strings at boot)
 * and pass through untouched, so a ref keeps carrying its ordering edge.
 */
import type { Config, ConfigParam, Params, ServiceNode } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';

// The ambient environment of whatever runtime hosts the bundle. Declared
// structurally so this entry imports no runtime's types. Writable: stash()
// re-emits the resolved config here under address-free keys.
declare const process: { env: Record<string, string | undefined> };

/** One declared param, paired with its owner and the raw ConfigParam (functions included). */
export interface ParamEntry {
  readonly owner: 'service' | { readonly input: string };
  readonly name: string;
  readonly param: ConfigParam;
}

/**
 * Walks a node's own params, then each dependency input's connection params —
 * the same enumeration order `configOf` uses, but carrying the raw
 * `ConfigParam` (with its `serialize`/`deserialize`) instead of a pure-data
 * projection.
 */
export function paramEntries(node: ServiceNode): readonly ParamEntry[] {
  const entries: ParamEntry[] = [];

  for (const [input, value] of Object.entries(node.inputs)) {
    if (typeof value !== 'object' || value === null) continue;
    const params = blindCast<
      { connection: { params: Params } },
      'a dependency input carries a connection'
    >(value).connection.params;
    for (const [name, param] of Object.entries(params)) {
      entries.push({ owner: { input }, name, param });
    }
  }

  for (const [name, param] of Object.entries(node.params)) {
    entries.push({ owner: 'service', name, param });
  }

  return entries;
}

export const configKey = (
  address: string,
  d: { owner: ParamEntry['owner']; name: string },
): string => {
  const segments = address.split('.').filter((s) => s.length > 0);
  const owner = d.owner === 'service' ? [] : [d.owner.input];
  // Every generated key lives in the framework's reserved COMPOSE_ namespace
  // (ADR-0029), so it can never collide with — and silently overwrite — a
  // user-provisioned platform var (e.g. a secret's external name). The poison
  // keys DATABASE_URL(_POOLED) are written directly in control.ts, not here, so
  // they stay unprefixed (they are the platform's own names).
  return ['COMPOSE', ...segments, ...owner, d.name].join('_').toUpperCase();
};

/**
 * A secret bound to a platform env-var NAME (ADR-0029): its config row holds
 * that name as a pointer, and the value lives ONLY in the external platform var.
 * A `secret` param WITHOUT `external` — e.g. a database url valued by its
 * producer — is not a pointer; it carries its value the ordinary way.
 */
function isPointerParam(param: ConfigParam): param is ConfigParam & { external: string } {
  return param.secret === true && param.external !== undefined;
}

/**
 * The string stored in a param's config row — shared by deploy `serialize` and
 * boot `stash` so writer and reader cannot drift. A pointer secret stores its
 * external platform-var NAME (never a value); every other param encodes its
 * value.
 */
export function storedForm(d: ParamEntry, value: unknown): string {
  if (isPointerParam(d.param)) return d.param.external;
  return encode(d.owner, value);
}

/**
 * Typed value → its stored string. Service-own literals are JSON-encoded; a
 * dependency-input value is a provisioning ref at deploy (and a resolved
 * string at boot) and passes through untouched — LANDMINE: JSON-encoding it
 * would break the ordering edge Alchemy resolves through it.
 */
export function encode(owner: ParamEntry['owner'], value: unknown): string {
  return owner === 'service'
    ? JSON.stringify(value)
    : blindCast<
        string,
        'a dependency-input value is a provisioning ref that flows through as its stored string'
      >(value);
}

/** Reverses `encode`: JSON-parse a service-own value, take a dependency-input value raw. */
function decode(owner: ParamEntry['owner'], raw: string): unknown {
  return owner === 'service' ? JSON.parse(raw) : raw;
}

function coerce(raw: string | undefined, d: ParamEntry, key: string): unknown {
  // "" is UNRESOLVED, not a value — falls to the default or, if required, is
  // a loud boot failure; a NON-EMPTY value that fails its param's declared
  // schema is an error regardless of any default (a default substitutes for
  // absence, never for garbage).
  const present = raw !== undefined && raw !== '';
  if (!present) {
    if (d.param.default !== undefined) return d.param.default;
    if (d.param.optional === true) return undefined;
    throw new Error(`missing required config param "${d.name}" (env ${key})`);
  }
  try {
    // A pointer secret's raw value is the plain platform string (already the
    // value, not JSON) — validate it directly; everything else decodes by owner.
    const decoded = isPointerParam(d.param) ? raw : decode(d.owner, raw);
    return standardValidateSync(d.param.schema, decoded);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid value for config param "${d.name}" (env ${key}): ${message}`);
  }
}

/**
 * Reads a param's stored form from the environment. A non-secret (or a secret
 * with no platform binding) reads its key directly. A pointer secret
 * double-looks-up (ADR-0029): the COMPOSE_ key holds the external platform-var
 * NAME, and the value lives ONLY in the external platform var. The label names both
 * keys so a missing required secret fails loudly and unambiguously.
 */
function readParam(d: ParamEntry, key: string): { raw: string | undefined; label: string } {
  if (isPointerParam(d.param)) {
    const stored = process.env[key];
    const name = stored !== undefined && stored !== '' ? stored : d.param.external;
    return { raw: process.env[name], label: `${key} → ${name}` };
  }
  return { raw: process.env[key], label: key };
}

/**
 * Boot: read each declared param from env by its key, reverse the param's own
 * serialization (missing/invalid fails loudly), assemble the typed Config.
 * The one place in the extension that reads the platform environment.
 */
export const deserialize = (node: ServiceNode, address: string): Config => {
  const service: Record<string, unknown> = {};
  const inputs: Record<string, Record<string, unknown>> = {};

  for (const d of paramEntries(node)) {
    const { raw, label } = readParam(d, configKey(address, d));
    const value = coerce(raw, d, label);
    if (d.owner === 'service') {
      service[d.name] = value;
    } else {
      let bucket = inputs[d.owner.input];
      if (bucket === undefined) {
        bucket = {};
        inputs[d.owner.input] = bucket;
      }
      bucket[d.name] = value;
    }
  }

  return { service, inputs };
};

/**
 * run()'s setup step: write the resolved config to the environment under
 * address-free keys (configKey("", d) + each serialize suffix), which load()
 * reads back with no address. Uses env, not a module variable, because a
 * framework may fork worker processes that inherit env but not memory.
 * Writes only these keys; nothing else is touched.
 */
export const stash = (node: ServiceNode, config: Config): void => {
  for (const d of paramEntries(node)) {
    const value =
      d.owner === 'service' ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name];
    if (value === undefined) continue;
    // A pointer secret re-emits its external-name POINTER (never the resolved
    // value), so the address-free deserialize double-looks-up identically — the
    // value stays only in the external platform var. storedForm holds this rule.
    process.env[configKey('', d)] = storedForm(d, value);
  }
};

/** Synchronous Standard Schema validation — see the matching note in core's `config.ts`. */
function standardValidateSync<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): StandardSchemaV1.InferOutput<S> {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new Error(
      'config param schema validation must be synchronous — async Standard Schema validators are not supported for config params',
    );
  }
  if (result.issues !== undefined) {
    throw new Error(
      `config param validation failed: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return result.value;
}
