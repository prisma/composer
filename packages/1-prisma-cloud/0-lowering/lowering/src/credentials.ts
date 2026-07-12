import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';

/**
 * The Prisma service token used to authenticate Management API calls. Kept
 * as a Redacted value so it never lands in logs or error output.
 */
export class PrismaCredentials extends Context.Service<
  PrismaCredentials,
  { readonly token: Redacted.Redacted<string> }
>()('PrismaCredentials') {}

/** Resolve the token from the `PRISMA_SERVICE_TOKEN` environment variable. */
export const fromEnv = (): Layer.Layer<PrismaCredentials, Config.ConfigError> =>
  Layer.effect(
    PrismaCredentials,
    Effect.gen(function* () {
      const token = yield* Config.redacted('PRISMA_SERVICE_TOKEN');
      return { token };
    }),
  );
