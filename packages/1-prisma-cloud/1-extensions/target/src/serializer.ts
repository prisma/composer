/**
 * The extension's config serializer — the semantic↔physical mapping, private to
 * the extension, SHARED by run() (boot) and /control's serialize (deploy) so writer
 * and reader cannot drift.
 *
 * Every key is `COMPOSER_`, then the service's full address starting with the
 * app name (its segments upper-cased, `-` turned into `_`), then the owner (the
 * input name, dropped for the service's own params), then the param name
 * (ADR-0057): in the app `shop`, `shop.auth`'s db.url ↔ COMPOSER_SHOP_AUTH_DB_URL.
 * The deploy writes and boot reads these keys. The only address-free form is
 * the boot stash: run() re-emits the resolved config as COMPOSER_DB_URL and so
 * on, which load() reads back without knowing the address. The platform's
 * DATABASE_URL is never among them: Prisma Cloud owns that name and the
 * framework refuses to bind it (see docs/design/05-prisma-cloud/alchemy-lowering.md).
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
import { isParamSource, isSecretPointer, isSecretSource } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { SecretBox } from '@internal/foundation/secret';
import {
  decodeParamPointer,
  encodeParamPointer,
  escapeKey,
  generatedMarker,
  INPUT_KEY_NAME,
  isParamPointerRow,
  type PlatformMarkerUse,
  platformMarker,
  readDocument,
  requiredParamUnsetMessage,
  withUnsetVariables,
} from '@internal/input-document';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { addressKeySegments, configKey, ORIGIN_KEY_NAME } from './config-key.ts';
import { configurationText } from './configuration-text.ts';
import { isEnvParamSource, isGeneratedParamSource, isOriginParamSource } from './param.ts';
import { RESERVED_PROVIDER_PARAMS } from './provider-params.ts';
import { secretName } from './secret.ts';

export {
  addressKeySegments,
  configKey,
  decodeParamPointer,
  encodeParamPointer,
  INPUT_KEY_NAME,
  isParamPointerRow,
  ORIGIN_KEY_NAME,
};

// The ambient environment of whatever runtime hosts the bundle. Declared
// structurally so this entry imports no runtime's types. Writable: run()
// applies stashRows() here under address-free keys.
declare const process: { env: Record<string, string | undefined> };

/** An environment to read rows from: `process.env` at boot, a materialized deployment environment for a dev server (ADR-0056). */
type Env = Readonly<Record<string, string | undefined>>;

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

function coerce(raw: string | undefined, d: ParamEntry, key: string, env: Env): unknown {
  // "" is unresolved, not a value: it falls to the default or, if required,
  // fails boot. A non-empty value that fails its schema is an error whatever
  // the default.
  const present = raw !== undefined && raw !== '';
  if (!present) {
    if (d.param.default !== undefined) return d.param.default;
    if (d.param.optional === true) return undefined;
    throw new Error(`missing required config param "${d.name}" (env ${key})`);
  }
  if (d.owner === 'service' && isParamPointerRow(raw)) {
    return coerceEnvSourcedParam(raw, d, key, env);
  }
  try {
    return standardValidateSync(d.param.schema, decode(d.owner, raw));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid value for config param "${d.name}" (env ${key}): ${message}`);
  }
}

/**
 * Boot resolution for a per-key `envParam()` param: the pointer row names a
 * platform variable, whose text the param's schema checks with no JSON
 * decode. An unset or empty variable takes the param's default, or is left
 * out when the param is optional, and fails boot only when it is required.
 */
function coerceEnvSourcedParam(raw: string, d: ParamEntry, key: string, env: Env): unknown {
  const platformVar = decodeParamPointer(raw);
  const value = env[platformVar];
  if (value === undefined || value === '') {
    if (d.param.default !== undefined) return d.param.default;
    if (d.param.optional === true) return undefined;
    throw new Error(requiredParamUnsetMessage(d.name, key, platformVar));
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
export const deserialize = (node: ServiceNode, address: string, env: Env = process.env): Config => {
  const service: Record<string, unknown> = {};
  const inputs: Record<string, Record<string, unknown>> = {};

  for (const d of paramEntries(node)) {
    const key = configKey(address, d);
    const value = coerce(env[key], d, key, env);
    let target = service;
    if (d.owner !== 'service') {
      let bucket = inputs[d.owner.input];
      if (bucket === undefined) {
        bucket = {};
        inputs[d.owner.input] = bucket;
      }
      target = bucket;
    }
    if (value !== undefined) target[d.name] = value;
  }

  return { service, inputs };
};

/**
 * The resolved config as address-free rows (configKey("", d)), which load()
 * reads back with no address. They go to the environment, not a module
 * variable, because a framework may fork worker processes that inherit env
 * but not memory. `bootstrapService` applies them directly; `stashRows`
 * builds on them.
 */
export const configRows = (node: ServiceNode, config: Config): Record<string, string> => {
  const rows: Record<string, string> = {};
  for (const d of paramEntries(node)) {
    const value =
      d.owner === 'service' ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name];
    if (value === undefined) continue;
    rows[configKey('', d)] = encode(d.owner, value);
  }
  return rows;
};

/**
 * What `run()` writes for a service whose deployment environment is `env`
 * (ADR-0056): the address-free stash rows — the declared params, the
 * reserved provider params and the input document — then `PORT`, and `HOST`
 * (`env.HOST` when set, else `0.0.0.0`). Pure: it reads `env` and writes
 * nothing. Throws the error `run()` would throw at boot for a row the
 * service cannot read. `run()` applies the result to `process.env`; under
 * `prisma dev` the Compute emulator starts a dev server with it.
 */
export function stashRows(node: ServiceNode, address: string, env: Env): Record<string, string> {
  const config = deserialize(node, address, env);
  const rows = configRows(node, config);
  // ADR-0031's provider-side sibling of the param rows above — the readers
  // are serve()'s accepted keys, the streams entrypoint's API_KEY, and
  // origin() (the framework-resolved ORIGIN row rides the same list). An
  // absent row stays absent (never provisioned); a present one is
  // schema-checked exactly like a declared param before it moves.
  for (const entry of RESERVED_PROVIDER_PARAMS) {
    const d: ParamEntry = {
      owner: 'service',
      name: entry.name,
      param: { schema: entry.schema, optional: true },
    };
    const key = configKey(address, d);
    const value = coerce(env[key], d, key, env);
    if (value === undefined) continue;
    rows[configKey('', d)] = encode('service', value);
  }
  // The input DOCUMENT moves address-free too, so input() reads the same row
  // with no address. It carries pointers, never values: secret values stay
  // only in their platform vars (ADR-0042).
  if (node.inputSchema !== undefined) {
    const raw = env[inputKey(address)];
    if (raw !== undefined) rows[inputKey('')] = raw;
  }
  // The resolved service port under the near-universal PORT convention, so a
  // framework-unaware server (Next.js's standalone server.js binds the PORT
  // env var) listens on the port Compute routes to — not its own default. A
  // server that reads port() explicitly is free to ignore it.
  const port = config.service['port'];
  if (typeof port === 'number') rows['PORT'] = String(port);
  // Compute routes to the workload over its network interface, not loopback.
  // Astro's Node adapter defaults HOST to localhost; preserve an explicit
  // author value, otherwise supply the framework-neutral listen-all address.
  rows['HOST'] = env['HOST'] ?? '0.0.0.0';
  return rows;
}

// ——— Input channel (ADR-0042): ONE self-describing JSON document per service.
//
// Deploy resolves the provision-time input binding (literals as-is, envParam
// leaves read from the app configuration, envSecret leaves as `$platform` markers),
// validates the resolved object with the service's own Standard Schema
// (each value known only at boot as its pointer — never a value), and writes the
// defaults-applied result to COMPOSER_<addr>_INPUT. Boot reads that one row,
// replaces each marker (`@internal/input-document`), validates again, and
// hands the app the typed object. Secret values never enter the document.

/** The input document row's key for a service address. */
export const inputKey = (address: string): string =>
  configKey(address, { owner: 'service', name: INPUT_KEY_NAME });

/**
 * The platform var the deploy provisions for a generated input leaf's value:
 * COMPOSER_<addr>_<KEY>_GENERATED, where <KEY> is the leaf's input-document
 * path normalized the way `configKey` normalizes its keys (segments joined
 * with "_", uppercased). Lives in the framework's reserved COMPOSER_ namespace
 * (envParam/envSecret reject COMPOSER_ names), so it can never collide with a
 * user-provisioned var.
 */
export const generatedParamVarName = (address: string, path: string): string => {
  const segments = addressKeySegments(address);
  const pathSegments = path.split('.').filter((s) => s.length > 0);
  return ['COMPOSER', ...segments, ...pathSegments, 'GENERATED'].join('_').toUpperCase();
};

/** A plain data object (not an array, not a class instance) — the only object shape a binding/document may nest. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const ABSENT: unique symbol = Symbol('composer-input-absent');

/** One generated input leaf the walk records: the descriptor provisions a `GeneratedParam` resource + an env row per entry, and the substitution emits its `$generated` pointer at `path`. */
export interface GeneratedLeaf {
  readonly varName: string;
  readonly bytes: number;
  readonly redacted: boolean;
  readonly path: string;
  /** A `serviceOrigin()` leaf's target address; its origin replaces the random value. */
  readonly origin?: string;
}

/** One generated variable name and the input path that produced it. */
export interface PointerName {
  readonly path: string;
  readonly varName: string;
}

/** What `resolveInputBinding` hands back: the schema-ready object, with each pointer in place, plus the generated leaves and every key path that resolved absent. */
export interface ResolvedInputBinding {
  readonly resolved: unknown;
  /** Every generated leaf — provisioned by the descriptor, substituted to a `$generated` pointer by path. */
  readonly generated: readonly GeneratedLeaf[];
  /** Dot-joined binding paths whose env-bound leaf resolved absent (unset/empty deploy-shell var, or a secret `prisma dev` found unset) — deploy-report fodder. */
  readonly absent: readonly string[];
}

const NO_ABSENT_SECRETS: ReadonlySet<string> = new Set();

function absentArrayPositionError(member: unknown, position: string, address: string): Error {
  const key = `input binding key "${position}" of service "${address}"`;
  if (isSecretSource(member)) {
    return new Error(
      `${key} reads the platform variable "${secretName(member, 'an array position')}", which has no value. An array position cannot be left out: set the variable, or bind a literal.`,
    );
  }
  if (isEnvParamSource(member)) {
    return new Error(
      `${key} reads "${member.payload.name}" from the app configuration, which has no value for it. An array position cannot be left out: set it where a \`config\` adapter reads it, or bind a literal.`,
    );
  }
  return new Error(
    `${key} resolved to no value, but only envSecret() and envParam() can. This is a framework bug.`,
  );
}

/** How `resolveInputBinding`, `serializeInput` and `inputValidationFailure` read the environment and which secrets they leave out. */
export interface SerializeInputOptions {
  /** Where `envParam` leaves are read: the app configuration, or in the second process the configuration key text from the app configuration file. The process environment when not given. */
  readonly env?: Readonly<Record<string, unknown>>;
  /** `envSecret` names to leave out of the document; only `prisma dev` passes any. */
  readonly absentSecrets?: ReadonlySet<string>;
}

function withDefaults(options: SerializeInputOptions): Required<SerializeInputOptions> {
  return {
    env: options.env ?? process.env,
    absentSecrets: options.absentSecrets ?? NO_ABSENT_SECRETS,
  };
}

/**
 * Every `$generated` variable a service's input binding produces must be
 * distinct after upper-casing (ADR-0041): Composer writes each one, so two
 * input paths that differ only in case would overwrite each other. Two
 * `$platform` markers for one name are two reads of one variable and are not
 * checked here.
 */
export function assertDistinctPointerNames(
  pointers: readonly PointerName[],
  address: string,
): void {
  const seen = new Map<string, PointerName>();
  for (const pointer of pointers) {
    const normalized = pointer.varName.toUpperCase();
    const prior = seen.get(normalized);
    if (prior !== undefined) {
      throw new Error(
        `invalid input for service "${address}": input paths "${prior.path}" and "${pointer.path}" ` +
          `both resolve to the generated variable "${normalized}" — generated variable names must be ` +
          'distinct (env var names compare case-insensitively).',
      );
    }
    seen.set(normalized, pointer);
  }
}

/**
 * Deploy: recursive descent over the provision-time binding (plain data).
 * `envSecret`, `generatedParam` and `serviceOrigin` leaves stay in place as
 * their pointers (the value never enters the deploy); `envParam` leaves read
 * the app configuration — unset or empty means the enclosing object key is
 * OMITTED, and the schema arbitrates whether that absence is legal
 * (ADR-0042). An `envSecret` leaf named in `absentSecrets` is omitted the
 * same way; only `prisma dev` passes any. Everything non-plain (a class
 * instance, a function, a raw SecretBox holding a value) is rejected loudly.
 */
export function resolveInputBinding(
  binding: unknown,
  address = '',
  options: SerializeInputOptions = {},
): ResolvedInputBinding {
  const { env, absentSecrets } = withDefaults(options);
  const generated: GeneratedLeaf[] = [];
  const pointers: PointerName[] = [];
  const absent: string[] = [];

  const walk = (value: unknown, path: string): unknown => {
    // A generated leaf is a ParamSource too, so it MUST be recognized before
    // the param branch. It stays in place as its pointer, which the schema
    // checks; serializing swaps it for a `{ "$generated": VAR, "redacted": <bool> }`
    // pointer by path. The walk itself provisions nothing.
    if (isOriginParamSource(value)) {
      const varName = generatedParamVarName(address, path);
      generated.push({ varName, bytes: 0, redacted: false, path, origin: value.payload.address });
      pointers.push({ path, varName });
      return value;
    }
    if (isGeneratedParamSource(value)) {
      const { bytes, redacted } = value.payload;
      const varName = generatedParamVarName(address, path);
      generated.push({ varName, bytes, redacted, path });
      pointers.push({ path, varName });
      return value;
    }
    if (isSecretSource(value)) {
      const name = secretName(
        value,
        path === '' ? 'the input binding root' : `input key "${path}"`,
      );
      if (absentSecrets.has(name)) {
        absent.push(path === '' ? `(root) → ${name}` : `${path} → ${name}`);
        return ABSENT;
      }
      return value;
    }
    if (isParamSource(value)) {
      if (!isEnvParamSource(value)) {
        throw new Error(
          `input binding${path === '' ? '' : ` key "${path}"`} is bound to a param source not ` +
            "created by envParam() — bind env-sourced input values with envParam('NAME') from " +
            '@prisma/composer-prisma-cloud.',
        );
      }
      const name = value.payload.name;
      const raw = configurationText(
        env,
        name,
        (kind) =>
          new Error(
            `input binding${path === '' ? '' : ` key "${path}"`} is bound to envParam('${name}'), but the \`config\` adapters return ${kind} for "${name}", not text. envParam() reads text; to pass other data, declare it in the root module's input.`,
          ),
      );
      if (raw === undefined) {
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
          throw absentArrayPositionError(member, `${path}[${index}]`, address);
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
  assertDistinctPointerNames(pointers, address);
  return {
    resolved: resolved === ABSENT ? undefined : resolved,
    generated,
    absent,
  };
}

/** One serialized input document, ready to write as an env row. */
export interface InputDocumentRow {
  readonly key: string;
  /** The JSON document: defaults applied, each secret leaf a `$platform` marker, each generated leaf a `$generated` marker, never a secret's value. */
  readonly value: string;
  /** Dot-joined binding paths whose env-bound leaf resolved absent — deploy-report fodder. */
  readonly absent: readonly string[];
  /** Generated leaves the descriptor must provision (a `GeneratedParam` resource + env row each). */
  readonly generated: readonly GeneratedLeaf[];
  /** Every `$platform` marker the document holds, in document order. Composer never writes the variables they name. */
  readonly markers: readonly PlatformMarkerUse[];
}

/** The text a stand-in box holds: known, and not a secret. */
const STAND_IN_TEXT = 'composer-stand-in-not-a-secret';

/**
 * Deploy: resolve the binding, judge it with the service's own schema (each
 * value known only at boot as its pointer), and serialize the
 * defaults-applied VALIDATED output, each pointer written as a `$platform` or
 * `$generated` marker, into one JSON row. Returns `undefined` for a service
 * with no input schema. A service whose binding holds a secret pointer is
 * judged a second time, with a stand-in box in place of each secret pointer,
 * and refused if a box loses its text: the schema copies its input, and at
 * boot the copy would lose the secret's value.
 */
export function serializeInput(
  node: ServiceNode,
  address: string,
  binding: unknown,
  options: SerializeInputOptions = {},
): InputDocumentRow | undefined {
  const judged = judgeInput(node, address, binding, options);
  if (judged === undefined) return undefined;
  if (!judged.ok) {
    throw new Error(
      `invalid input for service "${address}": ${judged.thrown ? '' : 'config param validation failed: '}${judged.message}\n` +
        '(Deploy-time validation sees each value known only at boot, envSecret() included, as a pointer ' +
        'to its platform variable, never its value. ' +
        'A failure naming a secret field means the binding and schema disagree about its ' +
        'secretness, or the schema refines on secret content — which ADR-0042 forbids.)',
    );
  }
  const { validated, generated, absent, resolved } = judged;
  refuseLostSecrets(node, address, resolved);
  const markers: PlatformMarkerUse[] = [];
  const document = substitutePointers(validated, generated, address, markers);
  return { key: inputKey(address), value: JSON.stringify(document), absent, generated, markers };
}

/**
 * Judges `resolved` a second time with a stand-in box in place of each secret
 * pointer, and fails naming the first field whose box no longer gives back
 * the stand-in's text. A schema that copies its input (an ArkType transform,
 * or deleting undeclared keys) copies a box without its value, so at boot the
 * service could not read the secret. Only the paths that held a stand-in are
 * judged: a box anywhere else came from the schema, and `substitutePointers`
 * refuses it. Does nothing when `resolved` holds no secret pointer.
 */
function refuseLostSecrets(node: ServiceNode, address: string, resolved: unknown): void {
  const standInPaths = new Set<string>();
  const withStandIns = (value: unknown, path: string): unknown => {
    if (isSecretPointer(value)) {
      standInPaths.add(path);
      return new SecretBox(STAND_IN_TEXT);
    }
    if (isSecretSource(value) || isParamSource(value)) return value;
    if (Array.isArray(value)) {
      return value.map((member, index) =>
        withStandIns(member, path === '' ? String(index) : `${path}.${index}`),
      );
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          withStandIns(member, path === '' ? key : `${path}.${key}`),
        ]),
      );
    }
    return value;
  };
  const standIns = withStandIns(resolved, '');
  if (standInPaths.size === 0 || node.inputSchema === undefined) return;
  const result = standardValidate(node.inputSchema, standIns);
  if ('issues' in result) {
    throw new Error(
      `invalid input for service "${address}": the schema accepts each secret's pointer but refuses a secret box in its place: ${result.issues}`,
    );
  }
  const walk = (value: unknown, path: string): void => {
    if (value instanceof SecretBox) {
      if (!standInPaths.has(path)) return;
      let text: unknown;
      try {
        text = value.expose();
      } catch {
        text = undefined;
      }
      if (text !== STAND_IN_TEXT) {
        throw new Error(
          `input key "${path}" of service "${address}" validated to a copy of its secret, and the copy ` +
            "has lost the secret's value: the schema copies its input (for example an ArkType morph " +
            'elsewhere in the schema), so the service would fail to read the secret at boot. Move the ' +
            'transform into the service code, or keep the schema free of transforms.',
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, member] of value.entries()) {
        walk(member, path === '' ? String(index) : `${path}.${index}`);
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, member] of Object.entries(value)) {
        walk(member, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  walk(result.value, '');
}

type InputJudgement =
  | ({ readonly ok: true; readonly validated: unknown } & ResolvedInputBinding)
  | {
      readonly ok: false;
      readonly message: string;
      /** True when the validator threw (an async or broken schema) rather than reporting issues. */
      readonly thrown: boolean;
    };

/** Resolves the binding and validates it with the service's schema; undefined for a service with no input schema. */
function judgeInput(
  node: ServiceNode,
  address: string,
  binding: unknown,
  options: SerializeInputOptions,
): InputJudgement | undefined {
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
  const resolved = resolveInputBinding(binding, address, options);
  let result: ReturnType<typeof standardValidate>;
  try {
    result = standardValidate(schema, resolved.resolved);
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
      thrown: true,
    };
  }
  return 'issues' in result
    ? { ok: false, message: result.issues, thrown: false }
    : { ok: true, validated: result.value, ...resolved };
}

/**
 * The schema's message when the service's input, with each `envSecret` leaf
 * in `absentSecrets` left out, fails validation; undefined when it passes or
 * the service has no input schema. Used by the `prisma dev` preflight.
 */
export function inputValidationFailure(
  node: ServiceNode,
  address: string,
  binding: unknown,
  options: SerializeInputOptions = {},
): string | undefined {
  const judged = judgeInput(node, address, binding, options);
  if (judged === undefined || judged.ok) return undefined;
  if (judged.thrown) throw new Error(`invalid input for service "${address}": ${judged.message}`);
  return judged.message;
}

/**
 * Walks the VALIDATED output and writes each pointer as its document marker:
 * an `envSecret` pointer as a `$platform` marker with `secret: true`, and a `generatedParam` or
 * `serviceOrigin` pointer as `{ "$generated": VAR, "redacted": <bool> }`, found
 * by the input path its binding put it at. A pointer is recognised by its
 * brands, never by identity, so a copy the schema made still counts. Escapes
 * any user key that matches a reserved marker. A `SecretString` in the output
 * came from the schema itself (a default or transform minting a box): no
 * platform var stands behind it, so it is rejected rather than serialized.
 */
function substitutePointers(
  value: unknown,
  generated: readonly GeneratedLeaf[],
  address: string,
  markers: PlatformMarkerUse[],
): unknown {
  const generatedByPath = new Map(generated.map((leaf) => [leaf.path, leaf]));
  const walk = (v: unknown, path: string, inArray = false): unknown => {
    const leaf = generatedByPath.get(path);
    if (isSecretSource(v)) {
      const name = secretName(v, path === '' ? 'the input binding root' : `input key "${path}"`);
      markers.push({ name, path, secret: true, inArray });
      return platformMarker(name, true);
    }
    if (isParamSource(v)) {
      if (leaf === undefined) {
        throw new Error(
          `input key "${path}" of service "${address}" validated to a value known only at boot that its ` +
            'binding did not put there: the schema moved it. A schema may check such a field, never move or transform it.',
        );
      }
      return generatedMarker(leaf.varName, leaf.redacted);
    }
    if (leaf !== undefined && v !== undefined) {
      throw new Error(
        `input key "${path}" of service "${address}" is bound to a value known only at boot, but the ` +
          'schema replaced it. A schema may check such a field, never move or transform it.',
      );
    }
    if (v instanceof SecretBox) {
      throw new Error(
        `input key "${path}" of service "${address}" validated to a SecretString the binding did ` +
          'not supply — a schema must not mint secret boxes (a default/transform cannot name a ' +
          "platform variable); bind the field with envSecret('NAME') instead.",
      );
    }
    if (Array.isArray(v)) {
      return v.map((m, i) => walk(m, path === '' ? String(i) : `${path}.${i}`, true));
    }
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(v)) {
        if (member === undefined) continue;
        out[escapeKey(key)] = walk(member, path === '' ? key : `${path}.${key}`);
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
 * Boot (`service.input()`): read the one input document row (address-free
 * after run()'s re-stash), replace each marker by `readDocument`'s rules,
 * and validate with the service's own schema. When the schema fails, the
 * error ends with the platform variables that had no value. A missing row
 * fails naming the env var: a deployed environment always writes it, and a
 * local harness must supply it.
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `this service's input document is not valid JSON (env ${key}): ${message} — a deployed ` +
        'environment writes it automatically; a local harness must supply the serialized input ' +
        `document (set ${key} to it).`,
    );
  }
  const { value, unset } = readDocument(parsed, {
    key,
    variable: (name) => process.env[name],
    secret: (text) => new SecretBox(text),
  });
  try {
    return standardValidateSync(schema, value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid input document (env ${key}): ${withUnsetVariables(message, unset)}`);
  }
}

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
 * Reads this service's origin back out of the address-free stash
 * `stashRows` wrote for the ORIGIN entry. `COMPOSER_ORIGIN` unset is
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
  const value = coerce(process.env[key], d, key, process.env);
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
  const result = standardValidate(schema, value);
  if ('issues' in result) throw new Error(`config param validation failed: ${result.issues}`);
  return result.value;
}

/** Synchronous validation that returns the issue messages, joined, instead of throwing them. */
function standardValidate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): { readonly value: StandardSchemaV1.InferOutput<S> } | { readonly issues: string } {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new Error(
      'config param schema validation must be synchronous — async Standard Schema validators are not supported for config params',
    );
  }
  if (result.issues !== undefined) {
    return { issues: result.issues.map((issue) => issue.message).join('; ') };
  }
  return { value: result.value };
}
