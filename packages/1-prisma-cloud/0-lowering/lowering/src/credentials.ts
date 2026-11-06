import { CliStructuredError } from '@internal/foundation/errors';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';
import pkg from '../package.json' with { type: 'json' };

/**
 * The Prisma service token used to authenticate Management API calls. Kept
 * as a Redacted value so it never lands in logs or error output.
 */
export class PrismaCredentials extends Context.Service<
  PrismaCredentials,
  { readonly token: Redacted.Redacted<string> }
>()('PrismaComposerCredentials') {}

/** Resolve the token from the `PRISMA_SERVICE_TOKEN` environment variable. */
export const fromEnv = (): Layer.Layer<PrismaCredentials, Config.ConfigError> =>
  Layer.effect(
    PrismaCredentials,
    Effect.gen(function* () {
      const token = yield* Config.Redacted('PRISMA_SERVICE_TOKEN');
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
const normalizedOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Prisma Management API URL must use HTTP or HTTPS.');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Prisma Management API URL must not contain credentials.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Prisma Management API URL must use HTTPS unless it targets a loopback host.');
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
};

const normalizeBaseUrl = (value: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => normalizedOrigin(value),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Invalid Prisma Management API URL: ${String(cause)}`),
  });

/**
 * Headers the Management API records in its deploy analytics: which tool sent
 * the request, and whether it ran in GitHub Actions. The API behaves the same
 * without them.
 */
export const deploySourceHeaders = (): Record<string, string> => ({
  'x-prisma-deploy-source': process.env['GITHUB_ACTIONS'] === 'true' ? 'github-action' : 'composer',
  'x-prisma-client-name': 'composer',
  'x-prisma-client-version': pkg.version,
});

/**
 * The Management API origin when no client is supplied: `PRISMA_API_URL`, then
 * `PRISMA_MANAGEMENT_API_URL`, then the public origin, normalized and validated
 * as upstream alchemy's `PrismaEnvironment` does. Composer's client built from
 * `PRISMA_SERVICE_TOKEN` and upstream's providers both use it, so they always
 * address the same host. A supplied client decides its own host; see
 * {@link suppliedClientOrigin}.
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
    : Config.String('PRISMA_API_URL').pipe(
        Config.orElse(() => Config.String('PRISMA_MANAGEMENT_API_URL')),
        Config.withDefault(DEFAULT_BASE_URL),
        Effect.flatMap(normalizeBaseUrl),
      );

/**
 * The origin a supplied client sends to. The `prisma` CLI builds `ctx.api` on
 * `PRISMA_MANAGEMENT_API_URL` alone, trimmed, or the public origin (prisma-cli
 * `getApiBaseUrl`), so Management API requests are recognised by that origin.
 * `PRISMA_API_URL` cannot move a supplied client, so when it names another
 * origin this throws `DEPLOY.MANAGEMENT_API_URL_CONFLICT` instead of ignoring it.
 */
export const suppliedClientOrigin = (env: Readonly<Record<string, string | undefined>>): string => {
  const engineValue = env['PRISMA_MANAGEMENT_API_URL']?.trim() || DEFAULT_BASE_URL;
  const origin = normalizedOrigin(engineValue);
  const composerValue = env['PRISMA_API_URL'];
  if (composerValue && normalizedOrigin(composerValue) !== origin) {
    throw new CliStructuredError(
      'DEPLOY.MANAGEMENT_API_URL_CONFLICT',
      `PRISMA_API_URL is ${composerValue}, but the deploy's Management API client sends to ${engineValue}.`,
      {
        why: "The deploy sends every Management API request through the client it was given. For `prisma deploy` that is the `prisma` CLI's client, which reads PRISMA_MANAGEMENT_API_URL (default https://api.prisma.io) and ignores PRISMA_API_URL.",
        fix: 'Set PRISMA_MANAGEMENT_API_URL to the host you want, and unset PRISMA_API_URL.',
      },
    );
  }
  return origin;
};
