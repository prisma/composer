import { isParamSource, type ParamBinding, type ParamSource, paramSource } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';

/**
 * Brands the payload `envParam` builds. Core's `paramSource()` is a public
 * SPI, so a user could bypass `envParam` and bind a raw `paramSource('x')`;
 * the brand lets `paramName` reject such a source (or another target's) with
 * a clear error instead of reading an absent `.name`.
 */
const PRISMA_CLOUD_PARAM_SOURCE: unique symbol = blindCast<
  never,
  'unique-symbol brand for the prisma-cloud envParam payload'
>(Symbol.for('prisma:prisma-cloud-param-source'));

/** The Prisma Cloud param source payload: the platform env-var name the slot resolves to, under a brand only `envParam` sets. */
export interface EnvParamPayload {
  readonly [PRISMA_CLOUD_PARAM_SOURCE]: true;
  readonly name: string;
}

const RESERVED_PARAM_PREFIX = 'COMPOSER_';
/** The names Prisma Cloud owns: it seeds and manages them, so Composer never binds one. */
const PLATFORM_OWNED_PARAM_NAMES: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'DATABASE_URL_POOLED',
]);

/**
 * Binds a param slot to a named Prisma Cloud platform env var — the non-secret
 * sibling of `envSecret` (spec: env-sourced config params). The platform
 * injects the value into the running instance per stage; the param's own
 * schema validates it at boot, unredacted. The name may not use the
 * framework's reserved `COMPOSER_` prefix or the platform-owned
 * `DATABASE_URL(_POOLED)` keys — same parity as `envSecret`.
 */
export function envParam(name: string): ParamSource<EnvParamPayload> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      "envParam() requires a non-empty platform env-var name, e.g. envParam('APP_ORIGIN').",
    );
  }
  if (name.startsWith(RESERVED_PARAM_PREFIX)) {
    throw new Error(
      `envParam name "${name}" may not start with "${RESERVED_PARAM_PREFIX}" — that prefix is ` +
        "reserved for the framework's own generated config keys.",
    );
  }
  if (PLATFORM_OWNED_PARAM_NAMES.has(name)) {
    throw new Error(
      `envParam name "${name}" is reserved — ${[...PLATFORM_OWNED_PARAM_NAMES].join(' and ')} ` +
        'are seeded and managed by Prisma Cloud itself, so the framework refuses to bind them. ' +
        'Declare the database your service uses and read its url from that connection.',
    );
  }
  return paramSource<EnvParamPayload>({ [PRISMA_CLOUD_PARAM_SOURCE]: true, name });
}

/** True only for a payload that `envParam` built — i.e. one carrying the brand. */
function isEnvParamPayload(payload: unknown): payload is EnvParamPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    blindCast<
      Record<PropertyKey, unknown>,
      'reading the prisma-cloud envParam brand off an unknown payload'
    >(payload)[PRISMA_CLOUD_PARAM_SOURCE] === true
  );
}

/** True iff a resolved param value is an env-sourced pointer this target built (as opposed to a literal, or a foreign/raw `ParamSource`). */
export function isEnvParamSource(value: unknown): value is ParamSource<EnvParamPayload> {
  return isParamSource(value) && isEnvParamPayload(value.payload);
}

/**
 * Brands the payload `generatedParam` builds — a distinct brand from
 * `envParam`'s, so `isGeneratedParamSource` and `isEnvParamSource` are mutually
 * exclusive even though both are `ParamSource`s.
 */
const PRISMA_CLOUD_GENERATED_PARAM_SOURCE: unique symbol = blindCast<
  never,
  'unique-symbol brand for the prisma-cloud generatedParam payload'
>(Symbol.for('prisma:prisma-cloud-generated-param-source'));

/** The Prisma Cloud generated param source payload: the generation parameters, under a brand only `generatedParam` sets. */
export interface GeneratedParamPayload {
  readonly [PRISMA_CLOUD_GENERATED_PARAM_SOURCE]: true;
  readonly bytes: number;
  readonly redacted: boolean;
}

/** Wiring info for a target-generated param value. */
export interface GeneratedParamOptions {
  /** Byte length of the generated value (base64-encoded). Default 32. */
  readonly bytes?: number;
  /** Redacted: boot wraps the value in the redacting box; the deploy report never prints it. Default true. */
  readonly redacted?: boolean;
}

const GENERATED_PARAM_DEFAULT_BYTES = 32;
const GENERATED_PARAM_MIN_BYTES = 16;
const GENERATED_PARAM_MAX_BYTES = 1024;

/**
 * Binds an input leaf to a value the target GENERATES at deploy — the sibling
 * of `envParam` whose value comes from deploy-time generation instead of the
 * environment. The generated value is produced once and persisted in deploy
 * state, so it is stable across redeploys (rotation is destroy/recreate). It is
 * config, not a secret; `redacted` is an orthogonal facet (default `true`).
 * `bytes` must be an integer between 16 and 1024 (default 32).
 */
export function generatedParam(
  opts: GeneratedParamOptions = {},
): ParamSource<GeneratedParamPayload> {
  const bytes = opts.bytes ?? GENERATED_PARAM_DEFAULT_BYTES;
  const redacted = opts.redacted ?? true;
  if (
    !Number.isInteger(bytes) ||
    bytes < GENERATED_PARAM_MIN_BYTES ||
    bytes > GENERATED_PARAM_MAX_BYTES
  ) {
    throw new Error(
      `generatedParam() bytes must be an integer between ${GENERATED_PARAM_MIN_BYTES} and ` +
        `${GENERATED_PARAM_MAX_BYTES} (got ${String(bytes)}).`,
    );
  }
  return paramSource<GeneratedParamPayload>({
    [PRISMA_CLOUD_GENERATED_PARAM_SOURCE]: true,
    bytes,
    redacted,
  });
}

/** True only for a payload that `generatedParam` built — i.e. one carrying the brand. */
function isGeneratedParamPayload(payload: unknown): payload is GeneratedParamPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    blindCast<
      Record<PropertyKey, unknown>,
      'reading the prisma-cloud generatedParam brand off an unknown payload'
    >(payload)[PRISMA_CLOUD_GENERATED_PARAM_SOURCE] === true
  );
}

/** True iff a resolved value is a generated-param source this target built (as opposed to a literal, an `envParam` source, or a foreign/raw `ParamSource`). */
export function isGeneratedParamSource(
  value: unknown,
): value is ParamSource<GeneratedParamPayload> {
  return isParamSource(value) && isGeneratedParamPayload(value.payload);
}

/**
 * Reads the Prisma Cloud env-var name back out of a param binding's opaque
 * source. A source not built by `envParam` (a raw `paramSource(...)` or
 * another target's source) carries no name — reject it here. `paramName` runs
 * in preflight and at serialize before any value ever crosses the wire, so a
 * foreign source fails early and clearly rather than producing a broken
 * deploy with an undefined name.
 */
export function paramName(binding: ParamBinding): string {
  const { binding: bound } = binding;
  if (!isEnvParamSource(bound)) {
    throw new Error(
      `param slot "${binding.slot}" of service "${binding.serviceAddress}" is bound to a source ` +
        "not created by envParam() — bind env-sourced params with envParam('NAME') from " +
        '@prisma/composer-prisma-cloud.',
    );
  }
  return bound.payload.name;
}

/**
 * Finds the manifest entry for one service param slot. `serialize` calls this
 * only after confirming `buildConfig` resolved the slot to a `ParamSource`
 * (`isParamSource(value)`), so a miss here means `graph.params` and the
 * resolved `Config` have drifted — a Load invariant violation, surfaced
 * loudly rather than producing a pointer row with an undefined name.
 */
export function paramBindingFor(
  bindings: readonly ParamBinding[],
  serviceAddress: string,
  slot: string,
): ParamBinding {
  const binding = bindings.find((b) => b.serviceAddress === serviceAddress && b.slot === slot);
  if (binding === undefined) {
    throw new Error(
      `param slot "${slot}" of "${serviceAddress}" resolved to a source but has no bound entry in ` +
        'the manifest — Load should have recorded it.',
    );
  }
  return binding;
}
