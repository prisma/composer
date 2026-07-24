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
import { isParamSource, isSecretSource } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { SecretBox, type SecretString } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { isEnvParamSource } from './param.ts';
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
  // Every generated key lives in the framework's reserved COMPOSER_ namespace
  // (ADR-0029), so it can never collide with — and silently overwrite — a
  // user-provisioned platform var (e.g. a secret's external name). The poison
  // keys DATABASE_URL(_POOLED) are written directly in control.ts, not here, so
  // they stay unprefixed (they are the platform's own names).
  return ['COMPOSER', ...segments, ...owner, d.name].join('_').toUpperCase();
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

// ——— Env-sourced param pointer rows: the non-secret sibling of the secret
// pointer channel below. A service's own param is EITHER literal-bound
// (JSON-encoded via `encode` above, unchanged) OR env-source-bound (a pointer
// to a platform var, this marker) for a given deploy — never both — so the
// two need to be told apart from the stored row alone, with no separate
// channel to consult. `JSON.stringify` output always starts with one of
// `"{[-0123456789tfn` (string/object/array/number/bool/null); the marker
// starts with `@`, which no JSON.stringify output can start with, so the two
// never collide.
const PARAM_POINTER_PREFIX = '@composer-param-pointer:';

/** True iff `raw` is a param pointer row (as opposed to a JSON-encoded literal). */
export const isParamPointerRow = (raw: string): boolean => raw.startsWith(PARAM_POINTER_PREFIX);

/** Builds a param pointer row's stored value from the platform var NAME it points to. */
export const encodeParamPointer = (name: string): string => `${PARAM_POINTER_PREFIX}${name}`;

/** Reverses `encodeParamPointer`: the platform var NAME a pointer row points to. */
export const decodeParamPointer = (raw: string): string => raw.slice(PARAM_POINTER_PREFIX.length);

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
  if (d.owner === 'service' && isParamPointerRow(raw)) {
    return coerceEnvSourcedParam(raw, d, key);
  }
  try {
    return standardValidateSync(d.param.schema, decode(d.owner, raw));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid value for config param "${d.name}" (env ${key}): ${message}`);
  }
}

/**
 * Boot resolution for an env-sourced param: double-lookup (pointer → platform
 * var), then the param's own schema on the raw string — no JSON decode, and
 * no redaction (it's config, not a secret). An UNSET platform var is a loud
 * boot failure naming both the param and the platform var; an EMPTY string is
 * not special-cased here — it reaches the schema like any other value, so it
 * passes iff the schema accepts it (deliberately unlike a literal param's own
 * ""-means-absent rule, and unlike a secret's non-empty requirement).
 */
function coerceEnvSourcedParam(raw: string, d: ParamEntry, key: string): unknown {
  const platformVar = decodeParamPointer(raw);
  const value = process.env[platformVar];
  if (value === undefined) {
    throw new Error(
      `env-sourced config param "${d.name}" (env ${key} → ${platformVar}) is unset: the platform ` +
        `variable "${platformVar}" was not injected — the deploy did not provision it.`,
    );
  }
  try {
    return standardValidateSync(d.param.schema, value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `invalid value for env-sourced config param "${d.name}" (env ${key} → ${platformVar}): ${message}`,
    );
  }
}

/**
 * Boot: read each declared param from env by its key, reverse the param's own
 * serialization (missing/invalid fails loudly), assemble the typed Config.
 * The input document rides its own channel (readInput), not this one.
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

// ——— Input channel (ADR-0042): ONE self-describing JSON document per service.
//
// Deploy resolves the provision-time input binding (literals as-is, envParam
// leaves read from the deploy shell, envSecret leaves as `$secret` pointers),
// validates the resolved object with the service's own Standard Schema
// (secrets as empty sentinel boxes — never values), and writes the
// defaults-applied result to COMPOSER_<addr>_INPUT. Boot reads that one row,
// swaps each pointer for a redacting box over the named platform var,
// validates again, and hands the app the typed object. Writer and reader
// share the walk below, so they cannot drift. Secret VALUES never enter the
// document.

/** The input document's own row name; its full key is COMPOSER_<addr>_INPUT. */
export const INPUT_KEY_NAME = 'INPUT';

/** The input document row's key for a service address. */
export const inputKey = (address: string): string =>
  configKey(address, { owner: 'service', name: INPUT_KEY_NAME });

// The document's one reserved key. User data may legitimately contain a
// "$secret" key, so the writer escapes any key matching /^\$+secret$/ by
// prefixing one more "$" ("$secret" → "$$secret", "$$secret" → "$$$secret"),
// and the reader strips one "$" back off — a round-trip under which only the
// framework can put a literal single-"$" marker in the document.
const SECRET_MARKER = '$secret';
const ESCAPABLE_KEY = /^\$+secret$/;
const ESCAPED_KEY = /^\$\$+secret$/;

/** True for the framework's secret pointer: `{ "$secret": "<PLATFORM_VAR>" }` and nothing else. */
function isSecretPointer(value: unknown): value is { readonly $secret: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    SECRET_MARKER in value &&
    typeof value[SECRET_MARKER] === 'string'
  );
}

/** A plain data object (not an array, not a class instance) — the only object shape a binding/document may nest. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const ABSENT: unique symbol = Symbol('composer-input-absent');

/** What `resolveInputBinding` hands back: the schema-ready object plus the sentinel→platform-name map and every key path that resolved absent. */
export interface ResolvedInputBinding {
  readonly resolved: unknown;
  /** Each secret leaf's sentinel box, mapped to the platform var it points to — identity is the lever `serializeInput` substitutes by. */
  readonly sentinels: ReadonlyMap<SecretString, string>;
  /** Dot-joined binding paths whose env-bound leaf resolved absent (unset/empty deploy-shell var) — deploy-report fodder. */
  readonly absent: readonly string[];
}

/**
 * Deploy: recursive descent over the provision-time binding (plain data).
 * `envSecret` leaves become empty sentinel `SecretBox`es (the value never
 * enters the deploy); `envParam` leaves read the deploy shell — unset or
 * empty means the enclosing object key is OMITTED, and the schema arbitrates
 * whether that absence is legal (ADR-0042). Everything non-plain (a class
 * instance, a function, a raw SecretBox holding a value) is rejected loudly.
 */
export function resolveInputBinding(
  binding: unknown,
  env: Record<string, string | undefined>,
): ResolvedInputBinding {
  const sentinels = new Map<SecretString, string>();
  const absent: string[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (isSecretSource(value)) {
      const name = secretName(
        value,
        path === '' ? 'the input binding root' : `input key "${path}"`,
      );
      const sentinel = new SecretBox('');
      sentinels.set(sentinel, name);
      return sentinel;
    }
    if (isParamSource(value)) {
      if (!isEnvParamSource(value)) {
        throw new Error(
          `input binding${path === '' ? '' : ` key "${path}"`} is bound to a param source not ` +
            "created by envParam() — bind env-sourced input values with envParam('NAME') from " +
            '@prisma/composer-prisma-cloud.',
        );
      }
      const raw = env[value.payload.name];
      if (raw === undefined || raw === '') {
        absent.push(
          path === '' ? `(root) → ${value.payload.name}` : `${path} → ${value.payload.name}`,
        );
        return ABSENT;
      }
      return raw;
    }
    if (Array.isArray(value)) {
      return value.map((member, index) => {
        const resolvedMember = walk(member, path === '' ? String(index) : `${path}.${index}`);
        if (resolvedMember === ABSENT) {
          throw new Error(
            `input binding key "${path}[${index}]" is an env-bound array element whose variable is ` +
              'unset — an array position cannot be omitted; bind a literal or provision the variable.',
          );
        }
        return resolvedMember;
      });
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(value)) {
        const resolvedMember = walk(member, path === '' ? key : `${path}.${key}`);
        if (resolvedMember === ABSENT) continue; // key omitted — the schema arbitrates absence
        out[key] = resolvedMember;
      }
      return out;
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    throw new Error(
      `input binding${path === '' ? '' : ` key "${path}"`} holds a value that is not plain data ` +
        `(${typeof value === 'object' ? 'a non-plain object' : `a ${typeof value}`}) — a binding's ` +
        'leaves are literals, envParam(...), or envSecret(...) (ADR-0042). A secret VALUE ' +
        "(e.g. a SecretBox) never belongs in a binding — bind envSecret('NAME') instead.",
    );
  };

  const resolved = walk(binding, '');
  return { resolved: resolved === ABSENT ? undefined : resolved, sentinels, absent };
}

/** One serialized input document, ready to write as an env row. */
export interface InputDocumentRow {
  readonly key: string;
  /** The JSON document — defaults-applied, secret leaves as `$secret` pointers, secret-free by construction. */
  readonly value: string;
  /** Dot-joined binding paths whose env-bound leaf resolved absent — deploy-report fodder. */
  readonly absent: readonly string[];
}

/**
 * Deploy: resolve the binding, judge it with the service's own schema
 * (secrets as opaque sentinel boxes), and serialize the defaults-applied
 * VALIDATED output — pointers substituted back where the sentinels sit — into
 * one JSON row. Returns `undefined` for a service with no input schema.
 * A validation failure that mentions a secret leaf means either a
 * misclassified binding (a literal where the schema wants a `SecretString`,
 * or vice versa) or a schema refining on secret CONTENT — deploy-time
 * validation sees only empty boxes, and the ADR forbids content refinements.
 */
export function serializeInput(
  node: ServiceNode,
  address: string,
  binding: unknown,
  env: Record<string, string | undefined> = process.env,
): InputDocumentRow | undefined {
  const schema = node.inputSchema;
  if (schema === undefined) {
    if (binding !== undefined) {
      throw new Error(
        `service "${address}" has an input binding but declares no input schema — Load should have rejected it (ADR-0042).`,
      );
    }
    return undefined;
  }
  if (binding === undefined) {
    throw new Error(
      `service "${address}" declares an input schema but has no recorded input binding — Load should have required it (ADR-0042).`,
    );
  }
  const { resolved, sentinels, absent } = resolveInputBinding(binding, env);
  let validated: unknown;
  try {
    validated = standardValidateSync(schema, resolved);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `invalid input for service "${address}": ${message}\n` +
        '(Deploy-time validation sees each envSecret leaf as an opaque, empty SecretString box. ' +
        'A failure naming a secret field means the binding and schema disagree about its ' +
        'secretness, or the schema refines on secret content — which ADR-0042 forbids.)',
    );
  }
  const document = substituteSecretPointers(validated, sentinels, address);
  return { key: inputKey(address), value: JSON.stringify(document), absent };
}

/**
 * Walks the VALIDATED output, mapping each sentinel box (by identity) back to
 * its `{ "$secret": name }` pointer and escaping any user key that matches
 * the reserved marker. A `SecretString` the walk does not recognize came from
 * the schema itself (a default or transform minting a box) — there is no
 * platform var behind it, so it is rejected rather than serialized.
 */
function substituteSecretPointers(
  value: unknown,
  sentinels: ReadonlyMap<SecretString, string>,
  address: string,
): unknown {
  const walk = (v: unknown, path: string): unknown => {
    if (v instanceof SecretBox) {
      const name = sentinels.get(v);
      if (name === undefined) {
        throw new Error(
          `input key "${path}" of service "${address}" validated to a SecretString the binding did ` +
            'not supply — a schema must not mint secret boxes (a default/transform cannot name a ' +
            "platform variable); bind the field with envSecret('NAME') instead.",
        );
      }
      return { [SECRET_MARKER]: name };
    }
    if (Array.isArray(v)) return v.map((m, i) => walk(m, `${path}[${i}]`));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(v)) {
        if (member === undefined) continue;
        const written = ESCAPABLE_KEY.test(key) ? `$${key}` : key;
        out[written] = walk(member, path === '' ? key : `${path}.${key}`);
      }
      return out;
    }
    if (
      v === null ||
      v === undefined ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      return v;
    }
    throw new Error(
      `input key "${path}" of service "${address}" validated to a value that cannot be serialized ` +
        `(a ${typeof v === 'object' ? 'non-plain object' : typeof v}) — the input document is plain JSON (ADR-0042).`,
    );
  };
  return walk(value, '');
}

/**
 * Boot: read the one input document row (address-free after run()'s
 * re-stash), swap each `$secret` pointer for a redacting box over the named
 * platform var, unescape reserved keys, validate with the service's own
 * schema, and return the typed object. A missing row is a loud failure naming
 * the env var — a deployed environment always writes it; a local harness must
 * supply it (set the row to the serialized input document).
 */
export function readInput(node: ServiceNode, address: string): unknown {
  const schema = node.inputSchema;
  if (schema === undefined) {
    throw new Error(
      `input() called on service "${node.name}", which declares no input schema — declare ` +
        '`input: <schema>` on compute() to use it (ADR-0042).',
    );
  }
  const key = inputKey(address);
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    throw new Error(
      `this service's input is not available (env ${key} is unset) — a deployed environment ` +
        'writes it automatically; a local harness must supply it like any other config value ' +
        `(set ${key} to the serialized input document).`,
    );
  }
  const hydrated = hydrateInputDocument(JSON.parse(raw), key);
  try {
    return standardValidateSync(schema, hydrated);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid input document (env ${key}): ${message}`);
  }
}

/** Reverses the document encoding: `$secret` pointers become redacting boxes over the named platform vars; escaped reserved keys drop one "$". */
function hydrateInputDocument(value: unknown, key: string): unknown {
  if (isSecretPointer(value)) {
    const name = value[SECRET_MARKER];
    const secret = process.env[name];
    if (secret === undefined || secret === '') {
      throw new Error(
        `secret input is not provisioned (env ${key} → ${name}): the platform var "${name}" is unset or empty.`,
      );
    }
    return new SecretBox(secret);
  }
  if (Array.isArray(value)) return value.map((member) => hydrateInputDocument(member, key));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, member] of Object.entries(value)) {
      const read = ESCAPED_KEY.test(k) ? k.slice(1) : k;
      out[read] = hydrateInputDocument(member, key);
    }
    return out;
  }
  return value;
}

/**
 * run()'s setup step for the input document: re-emit the row under its
 * address-free key, so the address-free `readInput` reads identically. The
 * document carries pointers, never values — the values stay only in their
 * platform vars.
 */
export const stashInput = (node: ServiceNode, address: string): void => {
  if (node.inputSchema === undefined) return;
  const raw = process.env[inputKey(address)];
  if (raw === undefined) return;
  process.env[inputKey('')] = raw;
};

// ——— Reserved provider params (ADR-0031): a provider-side minted value —
// the rpc accepted-key set, the streams API key — is a named, schema-carrying
// declaration owned by the target, exactly like a service's own param, but
// never part of `node.params`: nothing here reaches `config()`. Deploy writes
// its row the same way a service-own literal param does (JSON, through
// `encode`); boot validates and re-stashes it the same way `stash` does for a
// declared param. The difference from a declared param is only where the
// declaration comes from — the target's own registrations
// (`descriptors/shared.ts`'s `ProviderParam`), not the node the app authored.

/**
 * One reserved provider param's declaration: the boot-relevant half (name +
 * schema) of a `ProviderParam` — the half the target's runtime side needs,
 * without the deploy-only `value(refs)` function control.ts adds on top.
 *
 * `brand` is the ADR-0031 need brand this param answers for (e.g.
 * `RPC_PEER_KEY`, `STREAMS_API_KEY`). control.ts's `PROVIDER_PARAMS` is built
 * by mapping over the boot-side list of these entries (`provider-params.ts`'s
 * `RESERVED_PROVIDER_PARAMS`) and looking up each brand's `value(refs)` by
 * this field — so a param can exist on the deploy side only if it already
 * exists here.
 */
export interface ProviderParamEntry {
  readonly name: string;
  readonly schema: StandardSchemaV1;
  readonly brand: symbol;
}

/**
 * Boot: for each reserved provider param, read its address-scoped row through
 * the same `coerce` a declared param uses (JSON-decode, schema-validate), and
 * re-emit it address-free — `stash`'s counterpart for this separate
 * declaration space. A param is declared optional here unconditionally: an
 * absent row means "never provisioned" (local dev, tests, a provider with no
 * registered value for this deploy), never a boot failure, so nothing is
 * stashed and the runtime reader that owns this slot falls back to its own
 * pass-through behavior.
 */
export function stashProviderParams(entries: readonly ProviderParamEntry[], address: string): void {
  for (const entry of entries) {
    const d: ParamEntry = {
      owner: 'service',
      name: entry.name,
      param: { schema: entry.schema, optional: true },
    };
    const key = configKey(address, d);
    const value = coerce(process.env[key], d, key);
    if (value === undefined) continue;
    process.env[configKey('', d)] = encode('service', value);
  }
}

/** The framework-resolved origin row: COMPOSER_<addr>_ORIGIN. Written per
 *  compute service at serialize — the service's own provisioned endpoint URL,
 *  riding the reserved-provider-param machinery (`origin-key.ts`'s
 *  `ORIGIN_PARAM`); never a declared param, never in config(). A harness with
 *  no deploy behind it supplies it by setting `COMPOSER_ORIGIN` to the
 *  JSON-encoded origin URL — exactly how the existing entrypoint tests supply
 *  their other `COMPOSER_*` rows. */
export const ORIGIN_KEY_NAME = 'ORIGIN';

/**
 * Reads this service's origin back out of the address-free stash
 * `stashProviderParams` wrote for the ORIGIN entry. `COMPOSER_ORIGIN` unset is
 * a loud failure — a deployed environment always writes it, so an unset row
 * means either a local harness that hasn't supplied it or a boot() called
 * before run().
 */
export function readOrigin(): string {
  const d: ParamEntry = {
    owner: 'service',
    name: ORIGIN_KEY_NAME,
    param: { schema: type('string'), optional: true },
  };
  const key = configKey('', d);
  const value = coerce(process.env[key], d, key);
  if (value === undefined) {
    throw new Error(
      "this service's origin is not available (env COMPOSER_ORIGIN is unset) — a deployed environment writes it automatically; a local harness must supply it like any other config value (set COMPOSER_ORIGIN to the JSON-encoded origin URL).",
    );
  }
  return blindCast<
    string,
    "the entry's schema is type('string'), so coerce's schema-validated return is a string here"
  >(value);
}

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
