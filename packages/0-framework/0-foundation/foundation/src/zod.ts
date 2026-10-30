/**
 * Zod spellings of the framework's schema leaves. Opt-in: the framework
 * accepts any Standard Schema library (ADR-0042) and nothing outside this
 * module imports zod, so an app that uses ArkType never loads it.
 */
import { z } from 'zod';
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
 * input: z.object({ signingKey: secretString() })
 * ```
 */
export const secretString = () =>
  z.custom<SecretString>((value) => isSecretString(value) || isSecretPointer(value), {
    error: (issue) =>
      `must be a SecretString box — bind this field to a secret (was ${
        isPlainPointer(issue.input)
          ? 'a value known only at boot that is not a secret'
          : describeKind(issue.input)
      })`,
  });

/**
 * Wraps the schema of one leaf field so the field also accepts a plain
 * pointer, which stands for a value known only at boot. The field's input type
 * is `In | Pointer<In>` and its output type `Out | Pointer<In>`, where `In` and
 * `Out` are `inner`'s. A value that is not a pointer gets `inner`'s error.
 * Wrap a leaf, never an object schema.
 *
 * ```ts
 * input: z.object({ from: field(z.string()), port: field(z.string().transform(Number)) })
 * ```
 */
export function field<S extends z.ZodType>(
  inner: S,
): z.ZodType<z.output<S> | Pointer<z.input<S>>, z.input<S> | Pointer<z.input<S>>> {
  const pointer = z.custom((value) => isPlainPointer(value));
  return blindCast<
    z.ZodType<z.output<S> | Pointer<z.input<S>>, z.input<S> | Pointer<z.input<S>>>,
    "Zod infers the pointer branch as unknown; the branch admits only a plain pointer, which stands for the inner schema's input text"
  >(
    z.union([inner, pointer], {
      error: (issue) =>
        issue.code === 'invalid_union' ? issue.errors[0]?.[0]?.message : undefined,
    }),
  );
}
