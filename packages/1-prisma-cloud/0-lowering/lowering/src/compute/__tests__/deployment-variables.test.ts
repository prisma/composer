// Upstream's `Prisma.Deployment` with its `variables` prop, under the real Alchemy engine against a fake Management API that records every request.
import { expect, test } from 'bun:test';
import * as Prisma from '@alchemy.run/prisma';
import * as Provider from 'alchemy/Provider';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { data, fakeManagementApi, page } from '../../fake-management-api.ts';
import { runScratch, scratchStack } from '../../scratch-stack.ts';

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function fakePlatform(options: { failCreate?: boolean } = {}) {
  const requests: Recorded[] = [];
  const deployments = new Map<string, Record<string, unknown>>();
  const api = fakeManagementApi(({ method, path, body }) =>
    Effect.sync(() => {
      requests.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/v1/services/app-1/deployments')) {
        return page([...deployments.values()]);
      }
      if (method === 'POST' && path === '/v1/services/app-1/deployments') {
        if (options.failCreate === true) {
          return Response.json(
            { error: { code: 'bad-request', message: 'the platform refused the request' } },
            { status: 400 },
          );
        }
        const id = `dep-${deployments.size + 1}`;
        const deployment = {
          id,
          type: 'deployment',
          url: `https://api.prisma.test/v1/deployments/${id}`,
          serviceId: 'app-1',
          foundryVersionId: `fv-${id}`,
          status: 'new',
          previewDomain: null,
          createdAt: '2026-11-20T00:00:00.000Z',
        };
        deployments.set(id, deployment);
        return data({ ...deployment, uploadUrl: null });
      }
      const deployment = deployments.get(path.match(/^\/v1\/deployments\/([^/?]+)/)?.[1] ?? '');
      if (deployment !== undefined && method === 'GET') return data(deployment);
      if (deployment !== undefined && method === 'DELETE') {
        deployments.delete(String(deployment['id']));
        return new Response(null, { status: 204 });
      }
      return Response.json(
        { error: { code: 'unhandled', message: `${method} ${path}` } },
        { status: 400 },
      );
    }),
  );
  const providers = Layer.effect(Prisma.Providers, Provider.collection([Prisma.Deployment])).pipe(
    Layer.provideMerge(Prisma.DeploymentProvider()),
    Layer.provideMerge(api),
  );
  const creates = () =>
    requests.filter(
      (request) => request.method === 'POST' && request.path === '/v1/services/app-1/deployments',
    );
  return { requests, creates, stack: scratchStack({ providers, dev: false }, 'deployment-vars') };
}

const program = (variables?: Record<string, Redacted.Redacted<string> | null>) =>
  Effect.gen(function* () {
    yield* Prisma.Deployment('deployment', {
      app: 'app-1',
      skipCodeUpload: true,
      start: false,
      ...(variables === undefined ? {} : { variables }),
    });
  });

const variables = (port: string) => ({
  COMPOSER_SHOP_AUTH_PORT: Redacted.make(port),
  COMPOSER_SHOP_AUTH_STREAMS_API_KEY: null,
});

test('the create request carries the variables with their values unwrapped and their nulls kept', async () => {
  const { creates, stack } = fakePlatform();

  await runScratch(stack.deploy(program(variables('3000'))));

  expect(creates().map((request) => request.body)).toEqual([
    {
      skipCodeUpload: true,
      variables: { COMPOSER_SHOP_AUTH_PORT: '3000', COMPOSER_SHOP_AUTH_STREAMS_API_KEY: null },
    },
  ]);
});

test('a deployment without variables sends no variables field', async () => {
  const { creates, stack } = fakePlatform();

  await runScratch(stack.deploy(program()));

  expect(creates().map((request) => request.body)).toEqual([{ skipCodeUpload: true }]);
});

test('an unchanged redeploy creates no deployment and sends the variables nowhere', async () => {
  const { requests, creates, stack } = fakePlatform();
  await runScratch(stack.deploy(program(variables('3000'))));
  const before = requests.length;

  await runScratch(stack.deploy(program(variables('3000'))));

  expect(creates()).toHaveLength(1);
  expect(
    requests.slice(before).filter((request) => JSON.stringify(request.body ?? {}).includes('3000')),
  ).toEqual([]);
});

test('a changed value creates a new deployment that carries it', async () => {
  const { creates, stack } = fakePlatform();
  await runScratch(stack.deploy(program(variables('3000'))));

  await runScratch(stack.deploy(program(variables('8080'))));

  expect(creates().map((request) => request.body)).toEqual([
    {
      skipCodeUpload: true,
      variables: { COMPOSER_SHOP_AUTH_PORT: '3000', COMPOSER_SHOP_AUTH_STREAMS_API_KEY: null },
    },
    {
      skipCodeUpload: true,
      variables: { COMPOSER_SHOP_AUTH_PORT: '8080', COMPOSER_SHOP_AUTH_STREAMS_API_KEY: null },
    },
  ]);
});

test('declaring variables on a deployment created without them creates a new deployment', async () => {
  const { creates, stack } = fakePlatform();
  await runScratch(stack.deploy(program()));

  await runScratch(stack.deploy(program(variables('3000'))));

  expect(creates().map((request) => request.body)).toEqual([
    { skipCodeUpload: true },
    {
      skipCodeUpload: true,
      variables: { COMPOSER_SHOP_AUTH_PORT: '3000', COMPOSER_SHOP_AUTH_STREAMS_API_KEY: null },
    },
  ]);
});

test('a refused create fails without the values in its error', async () => {
  const { stack } = fakePlatform({ failCreate: true });
  const secret = 'postgres://user:hunter2@db.example/app';

  const exit = await runScratch(
    Effect.exit(stack.deploy(program({ COMPOSER_SHOP_AUTH_DB_URL: Redacted.make(secret) }))),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const text = `${Cause.pretty(exit.cause)} ${JSON.stringify(Cause.squash(exit.cause))}`;
    expect(text).toContain('the platform refused the request');
    expect(text).not.toContain('hunter2');
  }
});
