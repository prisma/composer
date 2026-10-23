import { describe, expect, test } from 'bun:test';
import { ManagementClient } from '../../client.ts';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import * as Provider from 'alchemy/Provider';
import { inMemoryState } from 'alchemy/State/InMemoryState';
import * as Core from 'alchemy/Test/Core';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
  CustomDomain,
  customDomainBranchName,
  customDomainProviderService,
} from '../CustomDomain.ts';

const props = {
  appId: 'cps_test',
  hostname: 'staging.example.com',
  deploymentId: 'cpv_test',
  projectId: 'proj_test',
  consoleUrl: 'https://console.prisma.io',
};
const url = 'https://console.prisma.io/test/test/compute/test/domains?setup=staging.example.com';
const domain = { id: 'dom_test', hostname: props.hostname, status: 'active' };
function fixture(status = 422, code = 'domain-ownership-required') {
  let domains: (typeof domain)[] = [];
  const requests: string[] = [];
  const client = createManagementApiClient({
    token: 'test',
    baseUrl: 'https://api.test',
    fetch: async (request) => {
      const req = request as Request;
      if (new URL(req.url).pathname.startsWith('/v1/projects/'))
        return Response.json({ data: { workspace: { id: 'wksp_test' } } });
      if (new URL(req.url).pathname.startsWith('/v1/branches/'))
        return Response.json({ data: { gitName: 'trunk' } });
      requests.push(req.method);
      if (req.method === 'GET')
        return Response.json({ data: domains, pagination: { hasMore: false, nextCursor: null } });
      if (req.method === 'DELETE') {
        domains = [];
        return new Response(null, { status: 204 });
      }
      return status === 201
        ? Response.json({ data: domain }, { status })
        : Response.json({ error: { code, message: 'Setup needed' } }, { status });
    },
  });
  const service = customDomainProviderService(client);
  const context = {
    id: 'test',
    fqn: 'test',
    instanceId: 'test',
    news: props,
    olds: props,
    output: undefined,
    bindings: {},
  } as Parameters<typeof service.reconcile>[0];
  return {
    service,
    client,
    context,
    requests,
    setDomains: (value: (typeof domain)[]) => {
      domains = value;
    },
  };
}

describe('custom domain lifecycle', () => {
  for (const [status, code] of [
    [422, 'domain-ownership-required'],
    [400, 'domain-dns-required'],
  ] as const) {
    test(`completes deployment while ${code} needs setup`, async () => {
      const f = fixture(status, code);
      expect(await Effect.runPromise(f.service.reconcile(f.context))).toEqual({
        hostname: props.hostname,
        status: 'setup_required',
        setupUrl: url,
      });
      expect(f.requests).toEqual(['GET', 'POST']);
      expect(
        await Effect.runPromise(f.service.read!({ ...f.context, olds: props })),
      ).toBeUndefined();
    });
  }
  test('connects automatically when DNS is ready', async () => {
    const f = fixture(201);
    expect(await Effect.runPromise(f.service.reconcile(f.context))).toMatchObject({
      domainId: domain.id,
      status: 'active',
    });
  });
  test('reuses a binding completed in Console without another certificate request', async () => {
    const f = fixture();
    f.setDomains([domain]);
    expect(await Effect.runPromise(f.service.reconcile(f.context))).toMatchObject({
      domainId: domain.id,
      status: 'active',
    });
    expect(f.requests).toEqual(['GET']);
    expect(await Effect.runPromise(f.service.read!({ ...f.context, olds: props }))).toMatchObject({
      domainId: domain.id,
    });
  });
  for (const status of [400, 401, 403, 409, 422, 429, 503]) {
    test(`does not hide unexpected HTTP ${status}`, async () => {
      const f = fixture(status, 'client-error');
      await expect(Effect.runPromise(f.service.reconcile(f.context))).rejects.toThrow();
    });
  }
  test('removes only the declared binding and preserves unrelated domains', async () => {
    const f = fixture();
    f.setDomains([domain, { ...domain, id: 'dom_other', hostname: 'other.example.com' }]);
    await Effect.runPromise(
      f.service.delete({
        ...f.context,
        olds: props,
        output: { hostname: props.hostname, status: 'active', setupUrl: url, domainId: domain.id },
      }),
    );
    expect(f.requests).toEqual(['GET', 'DELETE']);
  });
  test('does not delete a replaced binding using a stale id', async () => {
    const f = fixture();
    f.setDomains([domain]);
    await Effect.runPromise(
      f.service.delete({
        ...f.context,
        olds: props,
        output: { hostname: props.hostname, status: 'active', setupUrl: url, domainId: 'dom_old' },
      }),
    );
    expect(f.requests).toEqual(['GET']);
  });
});

class DomainProviders extends Provider.ProviderCollection<DomainProviders>()('DomainTest') {}

test('real deploy state retries pending setup, adopts Console completion, and removes a declaration', async () => {
  const f = fixture();
  const providers = Layer.effect(DomainProviders, Provider.collection([CustomDomain])).pipe(
    Layer.provideMerge(Provider.effect(CustomDomain, Effect.succeed(f.service))),
  );
  const options = { providers, state: inMemoryState(), dev: false };
  const stack = Core.scratchStack(options, 'custom-domain-setup');
  const program = Effect.gen(function* () {
    const domain = yield* CustomDomain('web-domain', props);
    return { status: domain.status };
  });
  await Core.run(
    Effect.gen(function* () {
      yield* stack.deploy(program);
      expect(f.requests.filter((method) => method === 'POST')).toHaveLength(1);
      yield* stack.deploy(program);
      expect(f.requests.filter((method) => method === 'POST')).toHaveLength(2);
      f.setDomains([domain]);
      yield* stack.deploy(program);
      expect(f.requests.filter((method) => method === 'POST')).toHaveLength(2);
      yield* stack.deploy(Effect.succeed({}));
      expect(f.requests.filter((method) => method === 'DELETE')).toHaveLength(1);
    }),
    options,
  );
});

test('selects the default branch by its platform name rather than a main or production alias', async () => {
  const f = fixture();
  expect(
    await Effect.runPromise(
      customDomainBranchName('br_default').pipe(Effect.provideService(ManagementClient, f.client)),
    ),
  ).toBe('trunk');
});
