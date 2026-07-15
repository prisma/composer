import { type SecretBinding, type SecretSource, secretSource } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';

/**
 * Brands the payload `envSecret` builds. Core's `secretSource()` is a public
 * SPI, so a user could bypass `envSecret` and bind a raw `secretSource('x')`;
 * the brand lets `secretName` reject such a source (or another target's) with a
 * clear error instead of reading an absent `.name`.
 */
const PRISMA_CLOUD_SECRET_SOURCE: unique symbol = blindCast<
  never,
  'unique-symbol brand for the prisma-cloud envSecret payload'
>(Symbol.for('prisma:prisma-cloud-secret-source'));

/** The Prisma Cloud secret source payload: the platform env-var name the slot resolves to, under a brand only `envSecret` sets. */
export interface EnvSecretPayload {
  readonly [PRISMA_CLOUD_SECRET_SOURCE]: true;
  readonly name: string;
}

const RESERVED_SECRET_PREFIX = 'COMPOSE_';
const POISONED_SECRET_NAMES: ReadonlySet<string> = new Set(['DATABASE_URL', 'DATABASE_URL_POOLED']);

/**
 * Binds a secret slot to a named Prisma Cloud platform env var (ADR-0029). The
 * value is provisioned out-of-band; only the name is carried. The name may not
 * use the framework's reserved `COMPOSE_` prefix or the poisoned
 * `DATABASE_URL(_POOLED)` keys.
 */
export function envSecret(name: string): SecretSource<EnvSecretPayload> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      "envSecret() requires a non-empty platform env-var name, e.g. envSecret('STRIPE_SECRET_KEY').",
    );
  }
  if (name.startsWith(RESERVED_SECRET_PREFIX)) {
    throw new Error(
      `envSecret name "${name}" may not start with "${RESERVED_SECRET_PREFIX}" — that prefix is ` +
        "reserved for the framework's own generated config keys.",
    );
  }
  if (POISONED_SECRET_NAMES.has(name)) {
    throw new Error(
      `envSecret name "${name}" is reserved — ${[...POISONED_SECRET_NAMES].join(' and ')} are ` +
        'poisoned at project provision and cannot back a secret.',
    );
  }
  return secretSource<EnvSecretPayload>({ [PRISMA_CLOUD_SECRET_SOURCE]: true, name });
}

/** True only for a payload that `envSecret` built — i.e. one carrying the brand. */
function isEnvSecretPayload(payload: unknown): payload is EnvSecretPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    blindCast<
      Record<PropertyKey, unknown>,
      'reading the prisma-cloud envSecret brand off an unknown payload'
    >(payload)[PRISMA_CLOUD_SECRET_SOURCE] === true
  );
}

/**
 * Reads the Prisma Cloud env-var name back out of a secret binding's opaque
 * source. A source not built by `envSecret` (a raw `secretSource(...)` or
 * another target's source) carries no name — reject it here. `secretName` runs
 * in preflight before any provisioning, so a foreign source fails early and
 * clearly rather than producing a broken deploy with an undefined name.
 */
export function secretName(binding: SecretBinding): string {
  const payload = binding.source.payload;
  if (!isEnvSecretPayload(payload)) {
    throw new Error(
      `secret slot "${binding.slot}" of service "${binding.serviceAddress}" is bound to a source ` +
        "not created by envSecret() — bind secrets with envSecret('NAME') from " +
        '@prisma/compose-prisma-cloud.',
    );
  }
  return payload.name;
}
