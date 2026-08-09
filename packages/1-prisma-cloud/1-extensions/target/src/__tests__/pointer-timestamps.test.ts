/**
 * Runs BOTH halves of the rotation-timestamp transport: the CLI half
 * produces a payload from a real `runPreflight`, the framework transport
 * carries it as env vars, and the alchemy half rebuilds the lookup from
 * those vars alone — injecting a lookup directly would pass even if nothing
 * were transported. Assertions are on `deployEnvFingerprintMaterial` (the
 * exact hashed text); the digest itself is stubbed process-globally by a
 * sibling test via `mock.module`.
 */
import { describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import { preflightEnv } from '@internal/core/config';
import {
  deployEnvFingerprintMaterial,
  type EnvFingerprintEntry,
  type ManagementApiClient,
} from '@internal/lowering';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PRISMA_CLOUD_EXTENSION_ID, PrismaCloudContainer } from '../container.ts';
import {
  deserializePointerUpdatedAt,
  pointerUpdatedAtLookup,
  serializePointerUpdatedAt,
} from '../control/pointer-timestamps.ts';
import { compute } from '../exports/index.ts';
import { runPreflight } from '../preflight.ts';
import { envSecret } from '../secret.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

/** Load never validates a binding, so a pass-anything schema is enough here. */
const anySchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

const graph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
        id: 'ingest',
        input: { stripeKey: envSecret('STRIPE_SECRET_KEY') },
      });
    }),
  );

/** A platform holding STRIPE_SECRET_KEY, last written at `updatedAt`. Its VALUE is never returned — the API returns none. */
const fakePlatform = (updatedAt: string): ManagementApiClient =>
  ({
    GET: async () => ({
      data: {
        data: [{ branchId: null, updatedAt }],
        pagination: { nextCursor: null, hasMore: false },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
    POST: async () => {
      throw new Error('this fake platform already has every name; nothing should be created');
    },
  }) as unknown as ManagementApiClient;

/** The service's rows as the deploy hook fingerprints them — the input document points at the rotating secret. */
const envRows: readonly EnvFingerprintEntry[] = [
  { key: 'COMPOSER_INGEST_PORT', value: '3000' },
  {
    key: 'COMPOSER_INGEST_INPUT',
    value: '{"stripeKey":{"$secret":"STRIPE_SECRET_KEY"}}',
    pointers: ['STRIPE_SECRET_KEY'],
  },
];

/** The CLI process: run the real preflight against a platform that last wrote the secret at `updatedAt`, and hand its findings to the framework transport. */
async function cliProcess(updatedAt: string): Promise<Record<string, string>> {
  const timestamps = await runPreflight(
    {
      graph: graph(),
      container: new PrismaCloudContainer({ appName: 'app', stage: undefined }, 'proj', undefined),
      stage: undefined,
    },
    { client: fakePlatform(updatedAt) },
  );
  const payload = serializePointerUpdatedAt(timestamps);
  return preflightEnv(
    payload === undefined ? new Map() : new Map([[PRISMA_CLOUD_EXTENSION_ID, payload]]),
  );
}

/**
 * The alchemy process: it never ran a preflight, so its own map is empty and
 * everything it knows comes from the transported env — exactly the state a
 * fresh `prismaCloud()` is in there. Returns the text the deployment's
 * fingerprint is the hash of.
 */
function alchemyProcessMaterial(env: Record<string, string>): string {
  return deployEnvFingerprintMaterial(envRows, pointerUpdatedAtLookup(new Map(), env));
}

describe('the rotation signal across the CLI → alchemy process boundary', () => {
  test('a secret rotated on the platform moves the fingerprint in the alchemy process', async () => {
    const before = alchemyProcessMaterial(await cliProcess('2026-05-05T12:00:00.000Z'));
    const after = alchemyProcessMaterial(await cliProcess('2026-07-07T09:15:00.000Z'));

    expect(after).not.toBe(before);
  });

  test('an unchanged secret leaves it standing still — the deployment is reused', async () => {
    const first = alchemyProcessMaterial(await cliProcess('2026-05-05T12:00:00.000Z'));
    const second = alchemyProcessMaterial(await cliProcess('2026-05-05T12:00:00.000Z'));

    expect(second).toBe(first);
  });

  test('what the transport carries is the timestamp preflight read, under the pointed name', async () => {
    const env = await cliProcess('2026-05-05T12:00:00.000Z');

    expect(env).toEqual({
      PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD:
        '{"STRIPE_SECRET_KEY":"2026-05-05T12:00:00.000Z"}',
    });
  });

  test('without the transport the alchemy process learns nothing — the fingerprint cannot move', async () => {
    // What the child saw before the timestamps were transported at all: every
    // name unknown, so a rotation is invisible. This is the failure the
    // transport exists to prevent.
    const untransported = alchemyProcessMaterial({});
    const rotated = alchemyProcessMaterial(await cliProcess('2026-07-07T09:15:00.000Z'));

    expect(alchemyProcessMaterial({})).toBe(untransported);
    expect(rotated).not.toBe(untransported);
  });
});

describe('what the payload may contain', () => {
  test('timestamps only — a name, an ISO time, and nothing else', () => {
    expect(
      serializePointerUpdatedAt(new Map([['STRIPE_SECRET_KEY', '2026-05-05T12:00:00.000Z']])),
    ).toBe('{"STRIPE_SECRET_KEY":"2026-05-05T12:00:00.000Z"}');
  });

  test('the same times in a different order serialize identically — sorted by name', () => {
    const one = new Map([
      ['A_KEY', '2026-01-01T00:00:00.000Z'],
      ['B_KEY', '2026-02-02T00:00:00.000Z'],
    ]);
    const other = new Map([...one].reverse());

    expect(serializePointerUpdatedAt(other)).toBe(serializePointerUpdatedAt(one));
  });

  test('a deploy with no pointed variable carries no payload at all', () => {
    expect(serializePointerUpdatedAt(new Map())).toBeUndefined();
  });

  test('a round trip preserves every name', () => {
    const timestamps = new Map([
      ['A_KEY', '2026-01-01T00:00:00.000Z'],
      ['B_KEY', '2026-02-02T00:00:00.000Z'],
    ]);
    const payload = serializePointerUpdatedAt(timestamps);

    expect([...deserializePointerUpdatedAt(payload)]).toEqual([...timestamps]);
  });

  test('an absent payload reads as an empty map — dev, and any run with nothing to carry', () => {
    expect(deserializePointerUpdatedAt(undefined).size).toBe(0);
  });

  test('a payload that is present but unreadable fails loudly rather than losing the signal', () => {
    expect(() => deserializePointerUpdatedAt('not json')).toThrow(/did not survive the transport/);
    expect(() => deserializePointerUpdatedAt('"a string"')).toThrow(/not a JSON object/);
    expect(() => deserializePointerUpdatedAt('{"A_KEY":42}')).toThrow(
      /"A_KEY" is not a string timestamp/,
    );
  });
});
