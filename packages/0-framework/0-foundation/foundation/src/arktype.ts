/**
 * ArkType spellings of the framework's schema leaves. Opt-in: the framework
 * accepts any Standard Schema library (ADR-0042) and nothing outside this
 * module imports arktype, so an app that uses Zod never loads it.
 */
import { type ArkError, type Type, type } from 'arktype';
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
    (value, ctx): value is SecretString | Pointer<SecretString> =>
      isSecretString(value) ||
      isSecretPointer(value) ||
      ctx.reject({
        expected: 'a SecretString box — bind this field to a secret',
        actual: isPlainPointer(value)
          ? 'a value known only at boot that is not a secret'
          : describeKind(value),
      }),
  );

/** Where a wrapped field's error sits, and what it was given. */
interface FieldError {
  readonly data: unknown;
  readonly path: readonly PropertyKey[];
  hasCode(code: 'union'): boolean;
}

/** `error`'s message as if it were reported at `parent` joined with its own path. */
function messageAt(parent: readonly PropertyKey[], error: ArkError): string {
  return error.transform(({ relativePath, prefixPath, ...input }) => ({
    ...input,
    path: [...parent, ...error.path],
  })).message;
}

/**
 * The error `inner` reports for the wrapped field's value: what a wrapped field
 * reports for a value that is not a pointer. When both branches are objects,
 * ArkType reports a union error, whose message is its problem alone, so each
 * inner error carries its full path from the field's parent.
 */
function innerProblem(inner: Type<unknown, unknown>, field: FieldError): string {
  const errors = inner(field.data);
  if (!(errors instanceof type.errors)) {
    return `must be ${inner.description} (was ${describeKind(field.data)})`;
  }
  return errors
    .map((error) => (field.hasCode('union') ? messageAt(field.path, error) : error.problem))
    .join('; ');
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
  >(checked.or(pointer).configure({ problem: (error) => innerProblem(checked, error) }));
}
