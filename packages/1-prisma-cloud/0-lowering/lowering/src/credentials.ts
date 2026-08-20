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

const DEFAULT_BASE_URL = 'https://api.prisma.io';

const isLoopbackHost = (hostname: string) =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]';

/** Same validation as upstream alchemy's `PrismaEnvironment`: an HTTP(S) origin, HTTPS unless loopback, no credentials, no path/query/fragment. */
const normalizeBaseUrl = (value: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('Prisma Management API URL must use HTTP or HTTPS.');
      }
      if (url.username.length > 0 || url.password.length > 0) {
        throw new Error('Prisma Management API URL must not contain credentials.');
      }
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
        throw new Error(
          'Prisma Management API URL must use HTTPS unless it targets a loopback host.',
        );
      }
      if (
        (url.pathname !== '/' && url.pathname !== '') ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        throw new Error(
          'Prisma Management API URL must be an origin without a path, query, or fragment.',
        );
      }
      return url.origin;
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Invalid Prisma Management API URL: ${String(cause)}`),
  });

/**
 * The Management API origin every Prisma-Cloud client in this package uses —
 * Composer's own SDK client AND upstream alchemy's postgres providers resolve
 * it through this one function, so `PRISMA_API_URL` can never point them at
 * different hosts. Mirrors upstream alchemy's `PrismaEnvironment` resolution:
 * `PRISMA_API_URL`, then `PRISMA_MANAGEMENT_API_URL`, then the public origin,
 * normalized and validated identically.
 */
export const managementApiBaseUrl = (
  env?: Readonly<Record<string, string | undefined>>,
): Effect.Effect<string, Config.ConfigError | Error> =>
  env !== undefined
    ? // `||`, not `??`: an empty string means unset, exactly as Effect's
      // Config provider treats an empty env var in the branch below.
      normalizeBaseUrl(
        env['PRISMA_API_URL'] || env['PRISMA_MANAGEMENT_API_URL'] || DEFAULT_BASE_URL,
      )
    : Config.string('PRISMA_API_URL').pipe(
        Config.orElse(() => Config.string('PRISMA_MANAGEMENT_API_URL')),
        Config.withDefault(DEFAULT_BASE_URL),
        Effect.flatMap(normalizeBaseUrl),
      );
