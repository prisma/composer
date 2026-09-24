import { expect, test } from 'bun:test';
import { Credentials } from '@distilled.cloud/prisma';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { PrismaCredentials } from '../credentials.ts';

test('Composer and generated Prisma API credentials coexist in one context', async () => {
  const token = Redacted.make('test-service-token');
  const services = Layer.mergeAll(
    Layer.succeed(PrismaCredentials, { token }),
    Layer.succeed(
      Credentials,
      Effect.succeed({ apiToken: token, apiBaseUrl: 'https://api.prisma.test' }),
    ),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const composer = yield* PrismaCredentials;
      const generated = yield* Credentials;
      return { composer, generated: yield* generated };
    }).pipe(Effect.provide(services)),
  );

  expect(Redacted.value(result.composer.token)).toBe('test-service-token');
  expect(Redacted.value(result.generated.apiToken)).toBe('test-service-token');
  expect(result.generated.apiBaseUrl).toBe('https://api.prisma.test');
});
