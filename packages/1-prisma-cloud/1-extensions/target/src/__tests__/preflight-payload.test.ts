/**
 * Runs BOTH halves of the deploy preflight transport: the CLI half
 * produces a payload from a real `runPreflight`, the framework transport
 * carries it as env vars, and the alchemy half rebuilds the lookup from
 * those vars alone — injecting a lookup directly would pass even if nothing
 * were transported. Assertions are on the `<name>:updatedAt` trigger members
 * the deploy hook builds from the lookup — the exact inputs
 * `Prisma.Deployment.triggers` fingerprints.
 */
import { describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import {
  type PreflightFindings,
  preflightEnv,
  type UnsetPlatformVariable,
} from '@internal/core/config';
import type { ManagementApiClient } from '@internal/lowering';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PRISMA_CLOUD_EXTENSION_ID, PrismaCloudContainer } from '../container.ts';
import {
  decodePreflightPayload,
  serializeDeployPreflightPayload,
  serializeDevPreflightPayload,
  transportedPreflight,
} from '../control/preflight-payload.ts';
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

/** A platform holding STRIPE_SECRET_KEY, last written at `updatedAt`, or no row when `updatedAt` is undefined. Its VALUE is never returned — the API returns none. */
const fakePlatform = (updatedAt: string | undefined): ManagementApiClient =>
  ({
    GET: async () => ({
      data: {
        data: updatedAt === undefined ? [] : [{ branchId: null, updatedAt }],
        pagination: { nextCursor: null, hasMore: false },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }),
    POST: async () => {
      throw new Error('preflight never creates a platform variable');
    },
  }) as unknown as ManagementApiClient;

const NONE: PreflightFindings = { unset: [] };

const UNSET: UnsetPlatformVariable = {
  name: 'MAIL_KEY',
  readers: [{ kind: 'unread', node: 'app.mail', nodeKind: 'module' }],
  commands: ["prisma project env add 'MAIL_KEY=<value>' --project 'proj' --role production"],
};

/** The pointed platform variables serialize collected for this service — the input document points at the rotating secret. */
const pointers = ['STRIPE_SECRET_KEY'];

/** The CLI process: run the real preflight against a platform that last wrote the secret at `updatedAt`, and hand its findings to the framework transport. */
async function cliProcess(updatedAt: string | undefined): Promise<Record<string, string>> {
  const result = await runPreflight(
    {
      graph: graph(),
      configuration: {},
      secrets: {},
      container: new PrismaCloudContainer(
        { appName: 'app', environment: 'production' },
        'proj',
        undefined,
      ),
      environment: 'production',
    },
    { client: fakePlatform(updatedAt) },
  );
  const payload = serializeDeployPreflightPayload(result);
  return preflightEnv(
    payload === undefined ? new Map() : new Map([[PRISMA_CLOUD_EXTENSION_ID, payload]]),
  );
}

/**
 * The alchemy process: it never ran a preflight, so its own map is empty and
 * everything it knows comes from the transported env — exactly the state a
 * fresh `prismaCloud()` is in there. Returns the `<name>:updatedAt` trigger
 * members the deploy hook declares on `Prisma.Deployment` — what upstream's
 * fingerprint moves on.
 */
function alchemyProcessPointerTriggers(env: Record<string, string>): Record<string, string> {
  const { pointerVersion } = transportedPreflight(new Map(), env);
  return Object.fromEntries(
    pointers.map((name) => [`${name}:updatedAt`, pointerVersion(name) ?? '?']),
  );
}

describe('the rotation signal across the CLI → alchemy process boundary', () => {
  test('a secret rotated on the platform moves the trigger member in the alchemy process', async () => {
    const before = alchemyProcessPointerTriggers(await cliProcess('2026-05-05T12:00:00.000Z'));
    const after = alchemyProcessPointerTriggers(await cliProcess('2026-07-07T09:15:00.000Z'));

    expect(after).not.toEqual(before);
  });

  test('an unchanged secret leaves it standing still — the deployment is reused', async () => {
    const first = alchemyProcessPointerTriggers(await cliProcess('2026-05-05T12:00:00.000Z'));
    const second = alchemyProcessPointerTriggers(await cliProcess('2026-05-05T12:00:00.000Z'));

    expect(second).toEqual(first);
  });

  test('what the transport carries is the timestamp preflight read, under the pointed name', async () => {
    const env = await cliProcess('2026-05-05T12:00:00.000Z');

    expect(env).toEqual({
      PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD:
        '{"updatedAt":{"STRIPE_SECRET_KEY":"2026-05-05T12:00:00.000Z"},"findings":{"unset":[]}}',
    });
  });

  test('a variable with no value that nothing requires reaches the alchemy process as a finding', async () => {
    const env = await cliProcess(undefined);

    expect(transportedPreflight(new Map(), env).findings).toEqual({
      unset: [
        {
          name: 'STRIPE_SECRET_KEY',
          readers: [{ kind: 'field', service: 'app.ingest', path: 'stripeKey' }],
          commands: [
            "prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --role production",
          ],
        },
      ],
    });
    expect(alchemyProcessPointerTriggers(env)).toEqual({ 'STRIPE_SECRET_KEY:updatedAt': '?' });
  });

  test('without the transport the alchemy process learns nothing — the trigger cannot move', async () => {
    // What the child saw before the timestamps were transported at all: every
    // name unknown, so a rotation is invisible. This is the failure the
    // transport exists to prevent.
    const untransported = alchemyProcessPointerTriggers({});
    const rotated = alchemyProcessPointerTriggers(await cliProcess('2026-07-07T09:15:00.000Z'));

    expect(alchemyProcessPointerTriggers({})).toEqual(untransported);
    expect(rotated).not.toEqual(untransported);
  });
});

describe('what the payload may contain', () => {
  test('names, times and readers only', () => {
    expect(
      serializeDeployPreflightPayload({
        updatedAt: new Map([['STRIPE_SECRET_KEY', '2026-05-05T12:00:00.000Z']]),
        findings: { unset: [UNSET] },
      }),
    ).toBe(
      '{"updatedAt":{"STRIPE_SECRET_KEY":"2026-05-05T12:00:00.000Z"},"findings":{"unset":[' +
        '{"name":"MAIL_KEY","readers":[{"kind":"unread","node":"app.mail","nodeKind":"module"}],' +
        `"commands":["prisma project env add 'MAIL_KEY=<value>' --project 'proj' --role production"]}]}}`,
    );
  });

  test('the same times in a different order serialize identically — sorted by name', () => {
    const one = new Map([
      ['A_KEY', '2026-01-01T00:00:00.000Z'],
      ['B_KEY', '2026-02-02T00:00:00.000Z'],
    ]);
    const other = new Map([...one].reverse());

    expect(serializeDeployPreflightPayload({ updatedAt: other, findings: NONE })).toBe(
      serializeDeployPreflightPayload({ updatedAt: one, findings: NONE }),
    );
  });

  test('a deploy with no pointed variable and no finding carries no payload at all', () => {
    expect(
      serializeDeployPreflightPayload({ updatedAt: new Map(), findings: NONE }),
    ).toBeUndefined();
  });

  test('a deploy with only a finding carries it', () => {
    const payload = serializeDeployPreflightPayload({
      updatedAt: new Map(),
      findings: { unset: [UNSET] },
    });

    expect(decodePreflightPayload(payload)).toEqual({
      kind: 'deploy',
      updatedAt: new Map(),
      findings: { unset: [UNSET] },
    });
  });

  test('a round trip preserves every name and finding', () => {
    const updatedAt = new Map([
      ['A_KEY', '2026-01-01T00:00:00.000Z'],
      ['B_KEY', '2026-02-02T00:00:00.000Z'],
    ]);
    const findings = { unset: [UNSET] };

    expect(
      decodePreflightPayload(serializeDeployPreflightPayload({ updatedAt, findings })),
    ).toEqual({ kind: 'deploy', updatedAt, findings });
  });

  test('an absent payload decodes as nothing sent', () => {
    expect(decodePreflightPayload(undefined)).toEqual({ kind: 'none' });
  });

  test('a payload that is present but unreadable fails loudly rather than losing the signal', () => {
    expect(() => decodePreflightPayload('not json')).toThrow(/did not survive the transport/);
    expect(() => decodePreflightPayload('"a string"')).toThrow(/not a JSON object/);
    expect(() =>
      decodePreflightPayload('{"updatedAt":{"A_KEY":42},"findings":{"unset":[]}}'),
    ).toThrow(/"updatedAt" is not an object of string timestamps/);
    expect(() =>
      decodePreflightPayload('{"updatedAt":{},"findings":{"unset":[{"name":"A_KEY"}]}}'),
    ).toThrow(/"findings" do not have the expected shape/);
  });
});

describe('one transport variable, two kinds of payload', () => {
  const childEnv = (payload: string | undefined) =>
    preflightEnv(
      payload === undefined ? new Map() : new Map([[PRISMA_CLOUD_EXTENSION_ID, payload]]),
    );

  test('a deploy payload names no absent secret and reads as timestamps', () => {
    const preflight = transportedPreflight(
      new Map(),
      childEnv(
        serializeDeployPreflightPayload({
          updatedAt: new Map([['STRIPE_SECRET_KEY', '2026-10-01T00:00:00Z']]),
          findings: { unset: [UNSET] },
        }),
      ),
    );

    expect([...preflight.absentSecrets]).toEqual([]);
    expect(preflight.pointerVersion('STRIPE_SECRET_KEY')).toBe('2026-10-01T00:00:00Z');
    expect(preflight.findings).toEqual({ unset: [UNSET] });
  });

  test('a dev payload carries the absent secrets and the value versions', () => {
    const preflight = transportedPreflight(
      new Map(),
      childEnv(
        serializeDevPreflightPayload({
          absentSecrets: ['STRIPE_WEBHOOK_SECRET'],
          pointerVersions: { STRIPE_SECRET_KEY: 'hmac-of-value' },
        }),
      ),
    );

    expect([...preflight.absentSecrets]).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect(preflight.pointerVersion('STRIPE_SECRET_KEY')).toBe('hmac-of-value');
    expect(preflight.findings).toEqual(NONE);
  });

  test('with no payload nothing is absent and every version is unknown', () => {
    const preflight = transportedPreflight(new Map(), childEnv(undefined));

    expect([...preflight.absentSecrets]).toEqual([]);
    expect(preflight.pointerVersion('STRIPE_SECRET_KEY')).toBeUndefined();
    expect(preflight.findings).toEqual(NONE);
  });

  test('a dev payload that does not parse fails loudly', () => {
    expect(() => decodePreflightPayload('dev:not json')).toThrow(/prisma dev/);
    expect(() => decodePreflightPayload('dev:{"absentSecrets":[]}')).toThrow(/expected shape/);
  });
});
