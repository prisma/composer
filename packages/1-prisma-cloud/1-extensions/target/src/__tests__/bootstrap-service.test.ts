/**
 * bootstrapService's environment writes: it feeds the booted entry exactly the
 * way a deployed boot is fed — the Config stash, the input document row
 * (ADR-0041, via the same serializeInput the deploy uses), and process.env.PORT
 * (mirroring run(), the channel an entry reads its port from).
 */
import { describe, expect, test } from 'bun:test';
import { isSecretString, type SecretString } from '@internal/core';
import { type } from 'arktype';
import { compute } from '../compute.ts';
import { envSecret } from '../secret.ts';
import { inputKey } from '../serializer.ts';
import { bootstrapService } from '../testing.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('bootstrapService', () => {
  test('exposes the concrete port as process.env.PORT before boot — mirroring run()', async () => {
    const app = compute({ name: 'web', deps: {}, build });
    let portAtBoot: string | undefined;
    await withEnv({ PORT: undefined, COMPOSER_PORT: undefined }, () =>
      bootstrapService(app, { service: { port: 4711 }, inputs: {} }, async () => {
        portAtBoot = process.env['PORT'];
      }),
    );
    expect(portAtBoot).toBe('4711');
  });

  test('writes the input document row so input() reads it like a deployed boot', async () => {
    const app = compute({
      name: 'web',
      deps: {},
      input: type({ greeting: 'string', apiKey: type('unknown').narrow(isSecretString) }),
      build,
    });
    let rowAtBoot: string | undefined;
    let readBack: { greeting: string; apiKey: SecretString } | undefined;
    await withEnv(
      {
        [inputKey('')]: undefined,
        PORT: undefined,
        COMPOSER_PORT: undefined,
        TEST_BOOTSTRAP_API_KEY: 'sk_test_boot',
      },
      () =>
        bootstrapService(
          app,
          {
            service: { port: 4712 },
            inputs: {},
            input: { greeting: 'hello', apiKey: envSecret('TEST_BOOTSTRAP_API_KEY') },
          },
          async () => {
            rowAtBoot = process.env[inputKey('')];
            readBack = app.input() as { greeting: string; apiKey: SecretString };
          },
        ),
    );
    expect(rowAtBoot).toBe('{"greeting":"hello","apiKey":{"$secret":"TEST_BOOTSTRAP_API_KEY"}}');
    expect(readBack?.greeting).toBe('hello');
    expect(readBack?.apiKey.expose()).toBe('sk_test_boot');
  });

  test('a declared input schema with no supplied binding fails loudly — parity with provision()', async () => {
    const app = compute({ name: 'web', deps: {}, input: type({ greeting: 'string' }), build });
    await withEnv({ COMPOSER_PORT: undefined, PORT: undefined }, async () => {
      await expect(bootstrapService(app, { service: { port: 4713 }, inputs: {} })).rejects.toThrow(
        /no recorded input binding/,
      );
    });
  });
});
