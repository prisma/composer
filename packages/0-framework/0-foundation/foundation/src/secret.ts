/**
 * A value wrapper that redacts everywhere except the one explicit reader,
 * `expose()`. Sensitivity is carried by the TYPE (`SecretBox<T>`), not a flag a
 * sink must remember to check: `String(box)`, template interpolation,
 * `JSON.stringify`, and `console.log`/`util.inspect` all print `[REDACTED]`, so
 * a secret can't leak through an accidental log or serialization.
 *
 * Every box carries a brand property keyed by the registered symbol
 * `Symbol.for('prisma:secret-box')`, which is what `isSecretString` checks. A
 * symbol key is invisible to `JSON.stringify` and `Object.keys`, so the box's
 * public shape still matches the platform's own `secrecy` type
 * (pdp-control-plane).
 */
import { blindCast } from './casts.ts';

const REDACTED = '[REDACTED]';

// Symbol.for, so a box built by a duplicated copy of this module in a bundle
// carries the identical key and still answers to `isSecretString`.
const SECRET_BOX: unique symbol = blindCast<never, 'unique-symbol brand for a secret box'>(
  Symbol.for('prisma:secret-box'),
);

export class SecretBox<T> {
  readonly [SECRET_BOX] = true;

  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** The sole explicit door to the wrapped value. */
  expose(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  valueOf(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

/** The common case: a secret string. */
export type SecretString = SecretBox<string>;

/**
 * True for a redacting secret box — what a schema's secret leaf checks
 * (ADR-0042). Reads the brand rather than `instanceof`, so a box from a
 * duplicated module copy in a bundle counts and a look-alike does not.
 */
export function isSecretString(value: unknown): value is SecretString {
  return (
    typeof value === 'object' &&
    value !== null &&
    blindCast<Record<PropertyKey, unknown>, 'reading the secret-box brand off an unknown object'>(
      value,
    )[SECRET_BOX] === true
  );
}
