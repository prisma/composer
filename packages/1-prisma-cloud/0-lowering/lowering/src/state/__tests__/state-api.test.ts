import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import { Stack } from 'alchemy';
import {
  type CreatedResourceState,
  makeHttpStateStore,
  type ReplacedResourceState,
  State,
  type StateService,
} from 'alchemy/State';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import * as Headers from 'effect/unstable/http/Headers';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import { stateLayerAgainst } from '../layer.ts';
import {
  acquireDeployLease,
  type DeployLease,
  heartbeatDeployLease,
  LEASE_HEADER,
  type LeaseScope,
  redactLeaseHeader,
  releaseDeployLease,
} from '../lease.ts';
import { FakeStateApi } from './fake-state-api.ts';

process.env['PRISMA_SERVICE_TOKEN'] = 'test-service-token';

const PROJECT_ID = 'proj-1';
const BRANCH_ID = 'br-1';
const STACK = 'demo-stack';
const STAGE = 'br_test123';

const scope: LeaseScope = {
  projectId: PROJECT_ID,
  branchId: BRANCH_ID,
  stack: STACK,
  stage: STAGE,
};

let fake: FakeStateApi;

beforeAll(async () => {
  fake = new FakeStateApi();
  await fake.start();
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
});

const sdkClient = () =>
  createManagementApiClient({ token: 'test-service-token', baseUrl: fake.origin });

/** The REAL stock alchemy client, pointed at the fake, carrying the lease header. */
const buildStore = (lease: DeployLease): Promise<StateService> =>
  Effect.runPromise(
    makeHttpStateStore({
      url: `${fake.origin}/v1/projects/${PROJECT_ID}/branches/${BRANCH_ID}/alchemy-state`,
      authToken: 'test-service-token',
      transformClient: (req) =>
        HttpClientRequest.setHeader(req, LEASE_HEADER, Redacted.value(lease.leaseId)),
      id: 'prisma-postgres',
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

const acquire = () => Effect.runPromise(acquireDeployLease(sdkClient(), scope));

const createdResource = (overrides: Partial<CreatedResourceState> = {}): CreatedResourceState => ({
  resourceType: 'Test.Resource',
  namespace: undefined,
  fqn: 'test/resource',
  logicalId: 'resource',
  instanceId: 'instance-1',
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: {},
  attr: {},
  ...overrides,
});

describe('the stock state client against the platform state API', () => {
  test('all core methods round-trip a resource and a stack output', async () => {
    const service = await buildStore(await acquire());
    const run = <A>(eff: Effect.Effect<A, unknown>) =>
      Effect.runPromise(eff as Effect.Effect<A, never>);

    expect(await run(service.listStacks())).toEqual([]);

    const value = createdResource({ fqn: 'app/db' });
    expect(await run(service.set({ stack: STACK, stage: STAGE, fqn: value.fqn, value }))).toEqual(
      value,
    );

    expect(await run(service.listStacks())).toEqual([STACK]);
    expect(await run(service.listStages(STACK))).toEqual([STAGE]);
    expect(await run(service.list({ stack: STACK, stage: STAGE }))).toEqual([value.fqn]);
    expect(await run(service.get({ stack: STACK, stage: STAGE, fqn: value.fqn }))).toEqual(value);

    const outputValue = { url: 'https://example.test' };
    expect(
      await run(service.setOutput({ stack: STACK, stage: STAGE, value: outputValue })),
    ).toEqual(outputValue);
    expect(await run(service.getOutput({ stack: STACK, stage: STAGE }))).toEqual(outputValue);

    await run(service.delete({ stack: STACK, stage: STAGE, fqn: value.fqn }));
    expect(await run(service.get({ stack: STACK, stage: STAGE, fqn: value.fqn }))).toBeUndefined();

    await run(service.setOutput({ stack: STACK, stage: STAGE, value: outputValue }));
    await run(service.deleteStack({ stack: STACK, stage: STAGE }));
    expect(await run(service.getOutput({ stack: STACK, stage: STAGE }))).toBeUndefined();
    expect(await run(service.listStacks())).toEqual([]);
  });

  test('an absent resource reads as undefined (the wire answers 200 with JSON null)', async () => {
    const service = await buildStore(await acquire());

    const absent = await Effect.runPromise(
      service.get({ stack: STACK, stage: STAGE, fqn: 'does/not-exist' }),
    );

    expect(absent).toBeUndefined();
  });

  test('a slash-bearing fqn round-trips — the client double-encodes, the server decodes once', async () => {
    const service = await buildStore(await acquire());
    const value = createdResource({ fqn: 'nested/name with spaces/%odd' });

    await Effect.runPromise(service.set({ stack: STACK, stage: STAGE, fqn: value.fqn, value }));

    expect(await Effect.runPromise(service.list({ stack: STACK, stage: STAGE }))).toEqual([
      value.fqn,
    ]);
    expect(
      await Effect.runPromise(service.get({ stack: STACK, stage: STAGE, fqn: value.fqn })),
    ).toEqual(value);
  });

  test('Redacted values round-trip byte-identically', async () => {
    const service = await buildStore(await acquire());
    const value = createdResource({
      fqn: 'app/secret',
      props: { token: Redacted.make('sk-live-abc123') },
    });

    await Effect.runPromise(service.set({ stack: STACK, stage: STAGE, fqn: value.fqn, value }));
    const revived = await Effect.runPromise(
      service.get({ stack: STACK, stage: STAGE, fqn: value.fqn }),
    );

    const props = (revived as CreatedResourceState | undefined)?.props;
    expect(Redacted.isRedacted(props?.['token'])).toBe(true);
    expect(Redacted.value<string>(props?.['token'])).toBe('sk-live-abc123');
  });

  test('getReplacedResources returns only replaced-status states', async () => {
    const service = await buildStore(await acquire());
    const created = createdResource({ fqn: 'app/created' });
    const replaced: ReplacedResourceState = {
      ...createdResource({ fqn: 'app/replaced' }),
      status: 'replaced',
      old: createdResource({ fqn: 'app/replaced' }),
      deleteFirst: false,
    };
    await Effect.runPromise(
      service.set({ stack: STACK, stage: STAGE, fqn: created.fqn, value: created }),
    );
    await Effect.runPromise(
      service.set({ stack: STACK, stage: STAGE, fqn: replaced.fqn, value: replaced }),
    );

    expect(
      await Effect.runPromise(service.getReplacedResources({ stack: STACK, stage: STAGE })),
    ).toEqual([replaced]);
  });

  test('losing the lease mid-run fails the next operation WITHOUT retries — exactly one request', async () => {
    const service = await buildStore(await acquire());
    const value = createdResource({ fqn: 'app/db' });
    await Effect.runPromise(service.set({ stack: STACK, stage: STAGE, fqn: value.fqn, value }));

    fake.revokeAllLeases();
    fake.requests.length = 0;

    const result = await Effect.runPromise(
      service.get({ stack: STACK, stage: STAGE, fqn: value.fqn }).pipe(Effect.flip),
    );

    expect(result._tag).toBe('StateStoreError');
    expect(result.message).toContain('409');
    expect(fake.countRequests(/GET .*\/resources\//)).toBe(1);
  });
});

describe('the deploy lease', () => {
  test('the lease header renders redacted when the state layer’s redaction entry is in context', async () => {
    const headers = Headers.fromInput({ [LEASE_HEADER]: 'lease-secret-1' });

    const withEntry = await Effect.runPromise(
      Effect.sync(() => JSON.stringify(headers)).pipe(Effect.provide(redactLeaseHeader)),
    );
    const withoutEntry = await Effect.runPromise(Effect.sync(() => JSON.stringify(headers)));

    expect(withEntry).not.toContain('lease-secret-1');
    expect(withEntry).toContain('<redacted>');
    expect(withoutEntry).toContain('lease-secret-1');
  });

  test('a second acquire for the same (stack, stage) fails fast naming the holder — no retry, no queueing', async () => {
    await acquire();
    fake.requests.length = 0;

    const error = await Effect.runPromise(acquireDeployLease(sdkClient(), scope).pipe(Effect.flip));

    expect(error.status).toBe(409);
    expect(error.message).toContain('is held by');
    expect(fake.countRequests(/POST .*\/lease/)).toBe(1);
  });

  test('release frees the lease so the next deploy can acquire it', async () => {
    const lease = await acquire();

    await Effect.runPromise(releaseDeployLease(sdkClient(), scope, lease));

    expect(fake.liveLeaseIds()).toEqual([]);
    await expect(acquire()).resolves.toBeDefined();
  });

  test('release after the lease already expired does not fail the run', async () => {
    const lease = await acquire();
    fake.revokeAllLeases();

    await expect(
      Effect.runPromise(releaseDeployLease(sdkClient(), scope, lease)),
    ).resolves.toBeUndefined();
  });

  test('the heartbeat extends the lease on schedule', async () => {
    const lease = await acquire();

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          heartbeatDeployLease(sdkClient(), scope, lease, '10 millis'),
        );
        yield* Effect.sleep('100 millis');
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(fake.countRequests(/PATCH .*\/lease/)).toBeGreaterThanOrEqual(2);
  });

  test('a heartbeat 404 (lease lost) stops the heartbeat without failing the run', async () => {
    const lease = await acquire();
    fake.revokeAllLeases();

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            heartbeatDeployLease(sdkClient(), scope, lease, '10 millis'),
          );
          // Joining succeeds only because the 404 ENDS the loop; a failing
          // heartbeat would reject this promise.
          yield* Fiber.join(fiber);
        }),
      ),
    ).resolves.toBeUndefined();

    const patchesAfterStop = fake.countRequests(/PATCH .*\/lease/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.countRequests(/PATCH .*\/lease/)).toBe(patchesAfterStop);
  });
});

describe('prismaStateLayer against the platform state API', () => {
  const stackContext = Layer.succeed(Stack, {
    name: STACK,
    stage: STAGE,
    resources: {},
    bindings: {},
    actions: {},
  });

  const runLayer = <A>(
    use: (service: StateService) => Effect.Effect<A, unknown>,
    ids: { projectId: string; branchId?: string; defaultBranchId?: string } = {
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
    },
  ): Promise<A> => {
    const layer = stateLayerAgainst(fake.origin, ids).pipe(
      Layer.provide(stackContext),
    ) as unknown as Layer.Layer<State>;
    return Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* yield* State;
        return yield* use(service).pipe(Effect.orDie);
      }).pipe(Effect.provide(layer)) as Effect.Effect<A>,
    );
  };

  test('layer init acquires the lease, serves state through the stock client, and releases on exit', async () => {
    const value = createdResource({ fqn: 'app/db' });

    const fetched = await runLayer((service) =>
      Effect.gen(function* () {
        yield* service.set({ stack: STACK, stage: STAGE, fqn: value.fqn, value });
        return yield* service.get({ stack: STACK, stage: STAGE, fqn: value.fqn });
      }),
    );

    expect(fetched).toEqual(value);
    // The scope's finalizer released the lease.
    expect(fake.liveLeaseIds()).toEqual([]);
  });

  test('a concurrent second deploy of the same stage fails immediately, naming the holder', async () => {
    // A live deploy holds the lease, acquired as another operator.
    const holderResponse = await fetch(
      `${fake.origin}/v1/projects/${PROJECT_ID}/branches/${BRANCH_ID}/alchemy-state/lease`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stack: STACK, stage: STAGE, holderDescription: 'alice@laptop' }),
      },
    );
    expect(holderResponse.status).toBe(201);
    fake.requests.length = 0;

    const error: unknown = await runLayer(() => Effect.void).catch((e: unknown) => e);

    expect(String(error)).toContain('acquiring the deploy lease');
    expect(String(error)).toContain('alice@laptop');
    // Fail-fast: the 409 was never retried.
    expect(fake.countRequests(/POST .*\/lease/)).toBe(1);
  });

  test('an empty scope with live apps on the branch refuses — the stage predates the platform state API', async () => {
    fake.apps.push({ id: 'app-1', name: 'legacy.web', projectId: PROJECT_ID, branchId: BRANCH_ID });

    const error: unknown = await runLayer(() => Effect.void).catch((e: unknown) => e);

    expect(String(error)).toContain('predates the platform state API');
    expect(String(error)).toContain('"legacy.web"');
    // The refusal released the lease on the way out.
    expect(fake.liveLeaseIds()).toEqual([]);
  });

  test('an empty scope with NO apps proceeds — a genuinely fresh stage deploys', async () => {
    await expect(runLayer(() => Effect.void)).resolves.toBeUndefined();
  });

  test('a non-empty scope proceeds even with live apps — a normal redeploy', async () => {
    fake.apps.push({ id: 'app-1', name: 'live.web', projectId: PROJECT_ID, branchId: BRANCH_ID });
    fake.seedResource(STACK, STAGE, 'app/db', createdResource({ fqn: 'app/db' }));

    await expect(runLayer(() => Effect.void)).resolves.toBeUndefined();
  });

  test('with no branch id, the default branch is resolved via the Management API', async () => {
    const value = createdResource({ fqn: 'app/default-branch' });

    await expect(
      runLayer((service) => service.set({ stack: STACK, stage: STAGE, fqn: value.fqn, value }), {
        projectId: PROJECT_ID,
      }),
    ).resolves.toEqual(value);

    // The write landed under the resolved default branch, not a literal.
    expect(fake.countRequests(/PUT .*br-default.*\/resources\//)).toBe(1);
  });
});
