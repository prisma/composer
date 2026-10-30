/**
 * ArkType spellings of the framework's schema leaves. Opt-in: the framework
 * accepts any Standard Schema library (ADR-0042) and nothing outside this
 * module imports arktype, so an app that uses Zod never loads it.
 */
import { type } from 'arktype';
import { describeKind } from './describe-kind.ts';
import { isPlainPointer, isSecretPointer } from './pointer.ts';
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
