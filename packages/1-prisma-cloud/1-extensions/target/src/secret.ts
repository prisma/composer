import { type Pointer, type RuntimeValue, type SecretSource, secretSource } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { SecretString } from '@internal/foundation/secret';
import { assertVariableName } from './variable-name.ts';

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

/**
 * A value pointing at a named Prisma Cloud platform secret variable (ADR-0029),
 * dereferenced at boot. Only the name is carried; the value is provisioned
 * out-of-band. `assertVariableName` says which names it accepts. It returns a value known
 * only at boot, which a resolve() function cannot list, and which throws when
 * turned into text.
 */
export function envSecret(
  name: string,
): SecretSource<EnvSecretPayload> & RuntimeValue<SecretString> {
  assertVariableName(name, 'envSecret');
  return secretSource<EnvSecretPayload, Pointer<SecretString>>(
    { [PRISMA_CLOUD_SECRET_SOURCE]: true, name },
    { label: `envSecret('${name}')`, secretsKey: name },
  );
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
 * Reads the Prisma Cloud env-var name back out of an opaque secret source —
 * an `envSecret` leaf of an input binding (ADR-0042). A source not built by
 * `envSecret` (a raw `secretSource(...)` or another target's source) carries
 * no name — reject it here, with `where` naming the leaf's position, so a
 * foreign source fails early and clearly rather than producing a broken
 * deploy with an undefined name.
 */
export function secretName(source: SecretSource, where: string): string {
  const payload = source.payload;
  if (!isEnvSecretPayload(payload)) {
    throw new Error(
      `${where} is bound to a secret source not created by envSecret() — bind secrets with ` +
        "envSecret('NAME') from @prisma/composer-prisma-cloud.",
    );
  }
  return payload.name;
}
