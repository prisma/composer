import { afterEach, describe, expect, test } from 'bun:test';
import type { ConfigAdapter, PrismaAppConfig } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import { dotenv } from '../config-adapters.ts';
import { readConfigPool, readSecretsPool } from '../config-pools.ts';

const base: PrismaAppConfig = {
  extensions: [],
  state: { extension: 'x', create: () => undefined as never },
};
const input = { environment: 'staging', configFile: '/app/prisma.config.ts' };

const section = (lists: Pick<PrismaAppConfig, 'config' | 'secrets'>): PrismaAppConfig => ({
  ...base,
  ...lists,
});

async function structuredError(run: () => Promise<unknown>): Promise<CliStructuredError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CliStructuredError) return error;
    throw error;
  }
  throw new Error('expected a CliStructuredError');
}

afterEach(() => {
  delete process.env['S4_PROBE'];
});

describe('readConfigPool and readSecretsPool', () => {
  test('with no config list, the config pool is the process environment', async () => {
    process.env['S4_PROBE'] = 'probe';

    expect((await readConfigPool(base, input))['S4_PROBE']).toBe('probe');
  });

  test('with no secrets list, the secrets pool is the process environment', async () => {
    process.env['S4_PROBE'] = 'probe';

    expect((await readSecretsPool(base, input))['S4_PROBE']).toBe('probe');
  });

  test('adapters merge by top-level key in list order, a later adapter winning', async () => {
    const config = [() => ({ A: '1', B: '1' }), () => ({ B: '2' })];

    expect(await readConfigPool(section({ config }), input)).toEqual({ A: '1', B: '2' });
  });

  test("an undefined value does not hide an earlier adapter's value", async () => {
    const config = [() => ({ A: '1' }), () => ({ A: undefined })];

    const pool = await readConfigPool(section({ config }), input);

    expect(pool).toEqual({ A: '1' });
  });

  test('the merge is shallow: a later object replaces an earlier one whole', async () => {
    const second = { b: 2 };
    const config = [() => ({ S: { a: 1 } }), () => ({ S: second })];

    const pool = await readConfigPool(section({ config }), input);

    expect(pool).toEqual({ S: { b: 2 } });
    expect(pool['S']).toBe(second);
  });

  test("each adapter receives the environment's name and the config file's directory", async () => {
    const seen: unknown[] = [];
    const recording: ConfigAdapter = (received) => {
      seen.push({ ...received });
      return {};
    };

    await readConfigPool(section({ config: [recording] }), input);

    expect(seen).toEqual([{ environment: 'staging', configDirectory: '/app' }]);
  });

  test('an async adapter is awaited, and adapters run one at a time in list order', async () => {
    const order: string[] = [];
    const adapter =
      (name: string): ConfigAdapter =>
      async () => {
        order.push(`${name}:start`);
        await new Promise((done) => setTimeout(done, 5));
        order.push(`${name}:end`);
        return { [name]: name };
      };

    const pool = await readConfigPool(section({ config: [adapter('a'), adapter('b')] }), input);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(pool).toEqual({ a: 'a', b: 'b' });
  });

  test('a list the author writes replaces the default', async () => {
    process.env['S4_PROBE'] = 'probe';

    expect(await readConfigPool(section({ config: [] }), input)).toEqual({});
  });

  test('an adapter that throws fails with CONFIG.ADAPTER_FAILED naming its list and position', async () => {
    const thrown = new Error('vault down');
    const secrets = [
      () => ({ OK: 'ok' }),
      () => {
        throw thrown;
      },
    ];

    const error = await structuredError(() => readSecretsPool(section({ secrets }), input));

    expect(error.code).toBe('CONFIG.ADAPTER_FAILED');
    expect(error.message).toBe(
      '`composer.secrets[1]` failed to read the values for the environment "staging".',
    );
    expect(error.why).toBe('It threw: vault down');
    expect(error.fix).toBe(
      'Fix the adapter, or remove it from `composer.secrets` in prisma.config.ts.',
    );
    expect(error.meta).toEqual({ field: 'secrets[1]' });
    expect(error.where).toEqual({ path: '/app/prisma.config.ts' });
    expect(error.cause).toBe(thrown);
  });

  test('an adapter that returns something other than an object fails with CONFIG.ADAPTER_INVALID', async () => {
    const cases: [unknown, string][] = [
      [null, 'null'],
      [[], 'an array'],
      ['x', 'a string'],
      [undefined, 'nothing'],
    ];
    for (const [returned, kind] of cases) {
      const config = [() => returned as never];

      const error = await structuredError(() => readConfigPool(section({ config }), input));

      expect(error.code).toBe('CONFIG.ADAPTER_INVALID');
      expect(error.message).toBe(
        `\`composer.config[0]\` returned ${kind}, not an object of values.`,
      );
      expect(error.fix).toBe(
        "Return an object whose keys are the names of the values, e.g. `{ EMAIL_FROM: 'shop@example.com' }`.",
      );
      expect(error.meta).toEqual({ field: 'config[0]' });
    }
  });

  test('an adapter factory in place of its adapter names the fix', async () => {
    const config = [dotenv as never];

    const error = await structuredError(() => readConfigPool(section({ config }), input));

    expect(error.code).toBe('CONFIG.ADAPTER_INVALID');
    expect(error.message).toBe(
      '`composer.config[0]` returned a function, not an object of values.',
    );
    expect(error.fix).toBe(
      'An adapter factory was put in the list instead of the adapter it makes: write `dotenv()`, not `dotenv`.',
    );
  });

  test('a secrets adapter that returns a value that is not text fails naming the key and its kind, never the value', async () => {
    const secrets = [() => ({ TOKEN: 918273645 })];

    const error = await structuredError(() => readSecretsPool(section({ secrets }), input));

    expect(error.code).toBe('CONFIG.ADAPTER_INVALID');
    expect(error.message).toBe(
      '`composer.secrets[0]` returned a number for "TOKEN", but a secret is text.',
    );
    expect(error.fix).toBe('Return the secret as a string. A platform variable holds text.');
    expect(JSON.stringify(error)).not.toContain('918273645');
    expect(error.message).not.toContain('918273645');
  });

  test('the pools are frozen plain objects', async () => {
    const config = section({ config: [() => ({ A: 'a' })], secrets: [() => ({ B: 'b' })] });

    for (const pool of [
      await readConfigPool(config, input),
      await readSecretsPool(config, input),
    ]) {
      expect(Object.isFrozen(pool)).toBe(true);
      expect(Object.getPrototypeOf(pool)).toBe(Object.prototype);
    }
  });
});
