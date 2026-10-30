/**
 * ArkType spellings of the framework's schema leaves. Opt-in: the framework
 * accepts any Standard Schema library (ADR-0042) and nothing outside this
 * module imports arktype, so an app that uses Zod never loads it.
 */
import { type Type, type } from 'arktype';
import { blindCast } from './casts.ts';
import { describeKind } from './describe-kind.ts';
import { isPlainPointer, isSecretPointer, type Pointer } from './pointer.ts';
import { isSecretString, type SecretString } from './secret.ts';

/**
 * A schema leaf that accepts only a redacting `SecretString` box or a secret
 * pointer, so `input().<field>.expose()` type-checks and binding a plain
 * literal there fails the deploy (ADR-0042). Its error names the refused
 * value's kind, never the value.
 *
 * ```ts
 * input: type({ signingKey: secretString() })
 * ```
 */
export const secretString = () =>
  type('unknown').narrow(
    (value, ctx): value is SecretString =>
      isSecretString(value) ||
      isSecretPointer(value) ||
      ctx.reject({
        expected: 'a SecretString box — bind this field to a secret',
        actual: isPlainPointer(value)
          ? 'a value known only at boot that is not a secret'
          : describeKind(value),
      }),
  );

/** The error `inner` reports for `data`: what a wrapped field reports for a value that is not a pointer. */
function innerProblem(inner: Type<unknown, unknown>, data: unknown): string {
  const errors = inner(data);
  if (errors instanceof type.errors) return errors.map((error) => error.problem).join('; ');
  return `must be ${inner.description} (was ${describeKind(data)})`;
}

/**
 * Wraps the schema of one leaf field so the field also accepts a plain
 * pointer, which stands for a value known only at boot. The field's input type
 * is `In | Pointer<In>` and its output type `Out | Pointer<In>`, where `In` and
 * `Out` are `inner`'s. A value that is not a pointer gets `inner`'s error.
 * Wrap a leaf, never an object schema; put a default outside the wrapper.
 *
 * ```ts
 * input: type({ from: field(type('string')), port: field(type('string.integer.parse')) })
 * ```
 */
export function field<t, $>(inner: Type<t, $>): Type<t | Pointer<Type<t, $>['inferIn']>, $> {
  const checked = blindCast<
    Type<unknown, unknown>,
    "field() calls only or(), configure() and the type itself, none of which depends on inner's type parameters; on the generic Type<t, $> those calls do not type-check"
  >(inner);
  const pointer = type('object').narrow((value) => isPlainPointer(value));
  return blindCast<
    Type<t | Pointer<Type<t, $>['inferIn']>, $>,
    "ArkType infers the pointer branch as object; the branch admits only a plain pointer, which stands for the inner schema's input text"
  >(checked.or(pointer).configure({ problem: (error) => innerProblem(checked, error.data) }));
}
