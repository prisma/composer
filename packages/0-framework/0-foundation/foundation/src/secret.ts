/**
 * A value wrapper that redacts everywhere except the one explicit reader,
 * `expose()`. Sensitivity is carried by the TYPE (`SecretBox<T>`), not a flag a
 * sink must remember to check: `String(box)`, template interpolation,
 * `JSON.stringify`, and `console.log`/`util.inspect` all print `[REDACTED]`, so
 * a secret can't leak through an accidental log or serialization.
 *
 * Shape matches the platform's own `secrecy` type (pdp-control-plane). The class
 * is nominal enough on its own — no phantom brand.
 */

const REDACTED = '[REDACTED]';

export class SecretBox<T> {
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
