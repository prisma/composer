import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import { probeDeployedUrl } from '../compute/Deployment.ts';

describe('probeDeployedUrl', () => {
  test('accepts an application response even when the application status is 500', async () => {
    const result = await Effect.runPromise(
      probeDeployedUrl('https://app.example.test', async () =>
        Promise.resolve(new Response('app error', { status: 500 })),
      ),
    );

    expect(result).toBeUndefined();
  });

  test('rejects the platform missing-service response', async () => {
    const exit = await Effect.runPromiseExit(
      probeDeployedUrl('https://app.example.test', async () =>
        Promise.resolve(
          new Response(null, {
            status: 404,
            headers: { 'x-prisma-internal-service-missing': 'true' },
          }),
        ),
      ),
    );

    expect(exit._tag).toBe('Failure');
  });

  test('becomes ready after the platform stops returning the missing-service marker', async () => {
    let attempts = 0;
    const probe = probeDeployedUrl('https://app.example.test', async () => {
      attempts++;
      return attempts < 3
        ? new Response(null, {
            status: 404,
            headers: { 'x-prisma-internal-service-missing': 'true' },
          })
        : new Response('not found in the app', { status: 404 });
    });

    await Effect.runPromise(probe.pipe(Effect.retry(Schedule.spaced('1 millis'))));

    expect(attempts).toBe(3);
  });
});
