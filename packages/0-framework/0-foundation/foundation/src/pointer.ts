/** A pointer: what a value known only at boot holds at deploy. It names the platform variable the service reads at boot, and records whether that variable holds a secret. */
import { blindCast } from './casts.ts';
import type { SecretString } from './secret.ts';

// Symbol.for, so a pointer built by a duplicated copy of this module carries the identical key.
const POINTER: unique symbol = blindCast<never, 'unique-symbol brand for a pointer'>(
  Symbol.for('prisma:pointer'),
);
// Type-only, never assigned: carries T so a Pointer<string> is not a Pointer<SecretString>.
declare const POINTER_TYPE: unique symbol;

export type { POINTER_TYPE };
export { POINTER };

/** Whether the variable a pointer names holds a secret. */
export type PointerKind = 'secret' | 'plain';

/** The real value at deploy of a value known only at boot: it names the platform variable that holds the text of a `T`. */
export interface Pointer<T> {
  readonly [POINTER]: PointerKind;
  readonly [POINTER_TYPE]?: T;
}

function kindOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, POINTER);
}

/** True for a plain pointer: a value known only at boot whose variable holds plain text. */
export function isPlainPointer(value: unknown): value is Pointer<string> {
  return kindOf(value) === 'plain';
}

/** True for a secret pointer: a value known only at boot whose variable holds a secret. */
export function isSecretPointer(value: unknown): value is Pointer<SecretString> {
  return kindOf(value) === 'secret';
}
