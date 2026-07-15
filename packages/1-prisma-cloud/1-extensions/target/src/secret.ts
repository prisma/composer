import { type SecretBinding, type SecretSource, secretSource } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';

/** The Prisma Cloud secret source payload: the platform env-var name the slot resolves to. */
export interface EnvSecretPayload {
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
  return secretSource({ name });
}

/** Reads the Prisma Cloud env-var name back out of a secret binding's opaque source — the target reading the payload its own `envSecret` authored. */
export function secretName(binding: SecretBinding): string {
  return blindCast<
    EnvSecretPayload,
    'the prisma-cloud target reads back the {name} payload its own envSecret authored'
  >(binding.source.payload).name;
}
