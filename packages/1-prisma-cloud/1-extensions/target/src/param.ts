import {
  isParamSource,
  type ParamBinding,
  type ParamSource,
  type Pointer,
  paramSource,
  type RuntimeValue,
} from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { SecretString } from '@internal/foundation/secret';
import { isPlainVariableSource, notAPlatformVariable } from './platform-variable.ts';

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
 * Binds an input leaf to a value the target GENERATES at deploy. The
 * generated value is produced once and persisted in deploy state, so it is
 * stable across redeploys (rotation is destroy/recreate). It is
 * config, not a secret; `redacted` is an orthogonal facet (default `true`).
 * `bytes` must be an integer between 16 and 1024 (default 32).
 */
export function generatedParam(
  opts?: GeneratedParamOptions & { readonly redacted?: true },
): ParamSource<GeneratedParamPayload> & RuntimeValue<SecretString>;
export function generatedParam(
  opts: GeneratedParamOptions & { readonly redacted: false },
): ParamSource<GeneratedParamPayload> & RuntimeValue<string>;
export function generatedParam(
  opts: GeneratedParamOptions,
): ParamSource<GeneratedParamPayload> & RuntimeValue<SecretString | string>;
export function generatedParam(
  opts: GeneratedParamOptions = {},
): ParamSource<GeneratedParamPayload> & RuntimeValue<SecretString | string> {
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
  return paramSource<GeneratedParamPayload, Pointer<SecretString | string>>(
    { [PRISMA_CLOUD_GENERATED_PARAM_SOURCE]: true, bytes, redacted },
    { label: 'generatedParam()', redacted },
  );
}

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

/** True iff `value` was built by `generatedParam`. */
export function isGeneratedParamSource(
  value: unknown,
): value is ParamSource<GeneratedParamPayload> {
  return isParamSource(value) && isGeneratedParamPayload(value.payload);
}

const PRISMA_CLOUD_ORIGIN_PARAM_SOURCE: unique symbol = Symbol.for(
  'prisma:prisma-cloud-origin-param-source',
);

export interface OriginParamPayload {
  readonly [PRISMA_CLOUD_ORIGIN_PARAM_SOURCE]: true;
  readonly address: string;
}

/**
 * Binds an input leaf to another service's public origin in the environment being deployed,
 * e.g. `auth()`'s `baseUrl: serviceOrigin('shop.web')`. `address` is the target service's
 * full address, starting with the app name.
 */
export function serviceOrigin(
  address: string,
): ParamSource<OriginParamPayload> & RuntimeValue<string> {
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error(
      "serviceOrigin() requires the target service's full address, e.g. serviceOrigin('shop.web').",
    );
  }
  return paramSource<OriginParamPayload, Pointer<string>>(
    { [PRISMA_CLOUD_ORIGIN_PARAM_SOURCE]: true, address },
    { label: `serviceOrigin('${address}')` },
  );
}

/** True iff `value` was built by `serviceOrigin`. */
export function isOriginParamSource(value: unknown): value is ParamSource<OriginParamPayload> {
  return (
    isParamSource(value) &&
    typeof value.payload === 'object' &&
    value.payload !== null &&
    PRISMA_CLOUD_ORIGIN_PARAM_SOURCE in value.payload &&
    value.payload[PRISMA_CLOUD_ORIGIN_PARAM_SOURCE] === true
  );
}

/** The name of the plain platform variable a per-key param is bound to. Throws for any other bound source. */
export function paramName(binding: ParamBinding): string {
  const { binding: bound } = binding;
  const where = `param slot "${binding.slot}" of service "${binding.serviceAddress}"`;
  if (!isPlainVariableSource(bound)) throw new Error(notAPlatformVariable(where));
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
