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
import type { Config, ConfigParam, Params, SecretBinding, ServiceNode } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { secretName } from './secret.ts';

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
    return standardValidateSync(d.param.schema, decode(d.owner, raw));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid value for config param "${d.name}" (env ${key}): ${message}`);
  }
}

/**
 * Boot: read each declared param from env by its key, reverse the param's own
 * serialization (missing/invalid fails loudly), assemble the typed Config.
 * Secrets ride a separate channel (deserializeSecrets), not this one.
 */
export const deserialize = (node: ServiceNode, address: string): Config => {
  const service: Record<string, unknown> = {};
  const inputs: Record<string, Record<string, unknown>> = {};

  for (const d of paramEntries(node)) {
    const key = configKey(address, d);
    const value = coerce(process.env[key], d, key);
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
    process.env[configKey('', d)] = encode(d.owner, value);
  }
};

// ——— Secret channel (ADR-0029): a POINTER row per secret slot, boot double-lookup.
//
// A secret is NOT a param — it is its own slot on the node (`node.secretSlots`).
// Deploy writes COMPOSE_<addr>_<slot> = <platform env-var NAME> (the name the
// root bound it to, from `graph.secrets`); the value never enters this row or
// deploy state. Boot reads that pointer, then the platform var it names, and
// wraps the result in a SecretBox (core's `hydrateSecrets`). Writer (deploy) and
// reader (boot) share `secretKey`, so they cannot drift.

/** The pointer-row key for a secret slot: COMPOSE_<addr>_<slot> (secrets are service-level). */
export const secretKey = (address: string, slot: string): string =>
  configKey(address, { owner: 'service', name: slot });

/** One secret pointer row to write at deploy: the slot's key mapped to the bound platform NAME. */
export interface SecretRow {
  readonly key: string;
  readonly name: string;
}

/**
 * Deploy: the pointer rows for a node's secret slots — each slot's key mapped to
 * the platform NAME the root bound it to (looked up in `graph.secrets`). Never a
 * value. A declared slot with no binding is a Load-invariant violation (Load
 * binds every slot), surfaced loudly here rather than written as a blank row.
 */
export function secretPointerRows(
  node: ServiceNode,
  address: string,
  bindings: readonly SecretBinding[],
): readonly SecretRow[] {
  const rows: SecretRow[] = [];
  for (const slot of Object.keys(node.secretSlots)) {
    const binding = bindings.find((b) => b.serviceAddress === address && b.slot === slot);
    if (binding === undefined) {
      throw new Error(
        `secret slot "${slot}" of "${address}" has no bound platform name — Load should have bound it (ADR-0029).`,
      );
    }
    rows.push({ key: secretKey(address, slot), name: secretName(binding) });
  }
  return rows;
}

/**
 * Boot: resolve every secret slot to its value by double-lookup — read the
 * pointer key (the platform NAME), then read that platform var. A missing
 * pointer or a missing/empty platform value is a loud failure naming both keys.
 * Returns a plain Record for core's `hydrateSecrets` to box.
 */
export const deserializeSecrets = (node: ServiceNode, address: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const slot of Object.keys(node.secretSlots)) {
    const key = secretKey(address, slot);
    const name = process.env[key];
    if (name === undefined || name === '') {
      throw new Error(
        `missing secret pointer for slot "${slot}" (env ${key}) — the deploy did not write it.`,
      );
    }
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(
        `secret "${slot}" is not provisioned (env ${key} → ${name}): the platform var "${name}" is unset or empty.`,
      );
    }
    values[slot] = value;
  }
  return values;
};

/**
 * run()'s setup step for secrets: re-emit each slot's pointer NAME under its
 * address-free key, so the address-free `deserializeSecrets` double-looks-up
 * identically. Never the value — the value stays only in the platform var.
 */
export const stashSecrets = (node: ServiceNode, address: string): void => {
  for (const slot of Object.keys(node.secretSlots)) {
    const name = process.env[secretKey(address, slot)];
    if (name === undefined) continue;
    process.env[secretKey('', slot)] = name;
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
