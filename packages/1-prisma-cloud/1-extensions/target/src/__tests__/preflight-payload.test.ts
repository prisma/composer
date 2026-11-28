import { describe, expect, test } from 'bun:test';
import { appRoot, Load } from '@internal/core';
import type { ManagementApiClient } from '@internal/lowering';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PrismaCloudContainer } from '../container.ts';
import {
  declaredServiceAddresses,
  decodePreflightPayload,
  preflightView,
  serializeDeployPreflightPayload,
  serializeDevPreflightPayload,
} from '../control/preflight-payload.ts';
import { prismaCloud } from '../exports/control.ts';
import { compute, rawPostgres, variable } from '../exports/index.ts';
import { runPreflight } from '../preflight.ts';

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
    appRoot('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
        id: 'ingest',
        input: { stripeKey: provision(variable.secret({ name: 'STRIPE_SECRET_KEY' })) },
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

const platformVariables = ['STRIPE_SECRET_KEY'];

/** The real preflight against a platform that last wrote the secret at `updatedAt`. */
const preflightAgainst = (updatedAt: string | undefined) =>
  runPreflight(
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

/** Runs the real preflight and returns the payload the deploy hands the lowering. */
async function preflightPayload(updatedAt: string | undefined): Promise<string | undefined> {
  return serializeDeployPreflightPayload(await preflightAgainst(updatedAt));
}

/** The `<name>:updatedAt` trigger members the deploy hook declares on `Prisma.Deployment`, as the lowering reads them from the payload — what upstream's fingerprint moves on. */
function variableTriggers(payload: string | undefined): Record<string, string> {
  const { platformVariableVersion } = preflightView(payload);
  return Object.fromEntries(
    platformVariables.map((name) => [`${name}:updatedAt`, platformVariableVersion(name) ?? '?']),
  );
}

describe('the rotation signal from the preflight to the lowering', () => {
  test('a secret rotated on the platform moves the trigger member', async () => {
    const before = variableTriggers(await preflightPayload('2026-05-05T12:00:00.000Z'));
    const after = variableTriggers(await preflightPayload('2026-07-07T09:15:00.000Z'));

    expect(after).not.toEqual(before);
  });

  test('an unchanged secret leaves it standing still — the deployment is reused', async () => {
    const first = variableTriggers(await preflightPayload('2026-05-05T12:00:00.000Z'));
    const second = variableTriggers(await preflightPayload('2026-05-05T12:00:00.000Z'));

    expect(second).toEqual(first);
  });

  test('the payload carries the timestamp preflight read, under the name of the platform variable', async () => {
    expect(await preflightPayload('2026-05-05T12:00:00.000Z')).toBe(
      '{"updatedAt":{"STRIPE_SECRET_KEY":"2026-05-05T12:00:00.000Z"}}',
    );
  });

  test('a variable with no value sends no payload, and its trigger member is unknown', async () => {
    const payload = await preflightPayload(undefined);

    expect(payload).toBeUndefined();
    expect(variableTriggers(payload)).toEqual({ 'STRIPE_SECRET_KEY:updatedAt': '?' });
  });

  test('without the payload the lowering learns nothing — the trigger cannot move', async () => {
    const withoutPayload = variableTriggers(undefined);
    const rotated = variableTriggers(await preflightPayload('2026-07-07T09:15:00.000Z'));

    expect(rotated).not.toEqual(withoutPayload);
  });
});

describe('what the payload may contain', () => {
  test("the payload holds each variable's name and last-change time, and no value", () => {
    expect(
      serializeDeployPreflightPayload({
        updatedAt: new Map([['STRIPE_SECRET_KEY', '2026-05-05T12:00:00.000Z']]),
      }),
    ).toBe('{"updatedAt":{"STRIPE_SECRET_KEY":"2026-05-05T12:00:00.000Z"}}');
  });

  test('the same times in a different order serialize identically — sorted by name', () => {
    const one = new Map([
      ['A_KEY', '2026-01-01T00:00:00.000Z'],
      ['B_KEY', '2026-02-02T00:00:00.000Z'],
    ]);
    const other = new Map([...one].reverse());

    expect(serializeDeployPreflightPayload({ updatedAt: other })).toBe(
      serializeDeployPreflightPayload({ updatedAt: one }),
    );
  });

  test('a deploy with no variable that has a row carries no payload at all', () => {
    expect(serializeDeployPreflightPayload({ updatedAt: new Map() })).toBeUndefined();
  });

  test('a round trip preserves every name and time', () => {
    const updatedAt = new Map([
      ['A_KEY', '2026-01-01T00:00:00.000Z'],
      ['B_KEY', '2026-02-02T00:00:00.000Z'],
    ]);

    expect(decodePreflightPayload(serializeDeployPreflightPayload({ updatedAt }))).toEqual({
      kind: 'deploy',
      updatedAt,
      serviceAddresses: [],
    });
  });

  test('the payload holds the address of every service the deploy declares, sorted, once each', () => {
    const payload = serializeDeployPreflightPayload({
      updatedAt: new Map(),
      serviceAddresses: ['shop.web', 'shop.api', 'shop.web'],
    });

    expect(payload).toBe('{"updatedAt":{},"serviceAddresses":["shop.api","shop.web"]}');
    expect(declaredServiceAddresses(payload)).toEqual(['shop.api', 'shop.web']);
  });

  test("the extension's preflight sends the address of every service the graph declares, and of no other node", async () => {
    const declared = Load(
      appRoot('shop', ({ provision }) => {
        provision(compute({ name: 'web', deps: {}, build }));
        provision(rawPostgres({ name: 'db' }));
      }),
    );

    const payload = await prismaCloud().preflight?.({
      graph: declared,
      configuration: {},
      secrets: {},
      container: new PrismaCloudContainer(
        { appName: 'shop', environment: 'production' },
        'proj',
        undefined,
      ),
      environment: 'production',
    });

    expect(declaredServiceAddresses(payload)).toEqual(['shop.web']);
  });

  test('no deploy payload declares no service addresses — a destroy runs no preflight', () => {
    expect(declaredServiceAddresses(undefined)).toEqual([]);
    expect(declaredServiceAddresses('{"updatedAt":{}}')).toEqual([]);
    expect(
      declaredServiceAddresses(
        serializeDevPreflightPayload({ absentVariables: [], platformVariableVersions: {} }),
      ),
    ).toEqual([]);
  });

  test('an absent payload decodes as nothing sent', () => {
    expect(decodePreflightPayload(undefined)).toEqual({ kind: 'none' });
  });

  test('a payload that is present but unreadable fails loudly rather than losing the signal', () => {
    expect(() => decodePreflightPayload('not json')).toThrow(/payload could not be read: /);
    expect(() => decodePreflightPayload('"a string"')).toThrow(/not a JSON object/);
    expect(() => decodePreflightPayload('{"updatedAt":{"A_KEY":42}}')).toThrow(
      /"updatedAt" is not an object of string timestamps/,
    );
    expect(() => decodePreflightPayload('{"updatedAt":{},"serviceAddresses":"shop.web"}')).toThrow(
      /"serviceAddresses" is not an array of strings/,
    );
  });
});

describe("each run's own preflight", () => {
  test('a variable deleted since the last check is treated as having no value', async () => {
    const versionAfter = async (updatedAt: string | undefined) =>
      preflightView(
        serializeDeployPreflightPayload(await preflightAgainst(updatedAt)),
      ).platformVariableVersion('STRIPE_SECRET_KEY');

    expect(await versionAfter('2026-07-07T09:15:00.000Z')).toBe('2026-07-07T09:15:00.000Z');
    expect(await versionAfter(undefined)).toBeUndefined();
  });
});

describe('one payload, two kinds', () => {
  test('a deploy payload names no absent secret and reads as timestamps', () => {
    const preflight = preflightView(
      serializeDeployPreflightPayload({
        updatedAt: new Map([['STRIPE_SECRET_KEY', '2026-10-01T00:00:00Z']]),
      }),
    );

    expect([...preflight.absentVariables]).toEqual([]);
    expect(preflight.platformVariableVersion('STRIPE_SECRET_KEY')).toBe('2026-10-01T00:00:00Z');
  });

  test('a dev payload carries the absent variables and the value versions', () => {
    const preflight = preflightView(
      serializeDevPreflightPayload({
        absentVariables: ['STRIPE_WEBHOOK_SECRET'],
        platformVariableVersions: { STRIPE_SECRET_KEY: 'hmac-of-value' },
      }),
    );

    expect([...preflight.absentVariables]).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect(preflight.platformVariableVersion('STRIPE_SECRET_KEY')).toBe('hmac-of-value');
  });

  test('with no payload nothing is absent and every version is unknown', () => {
    const preflight = preflightView(undefined);

    expect([...preflight.absentVariables]).toEqual([]);
    expect(preflight.platformVariableVersion('STRIPE_SECRET_KEY')).toBeUndefined();
  });

  test('a dev payload that does not parse fails loudly', () => {
    expect(() => decodePreflightPayload('dev:not json')).toThrow(/prisma dev/);
    expect(() => decodePreflightPayload('dev:{"absentVariables":[]}')).toThrow(/expected shape/);
  });
});
