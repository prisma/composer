import { expect, test } from 'bun:test';
import type { LowerContext, LoweredResult } from '@internal/core/deploy';
import {
  CustomDomain,
  customDomainProviderService,
  type ManagementApiClient,
} from '@internal/lowering';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import { inMemoryState } from 'alchemy/State/InMemoryState';
import * as Core from 'alchemy/Test/Core';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { computeDescriptor } from '../descriptors/compute.ts';

class TestProviders extends Provider.ProviderCollection<TestProviders>()('DomainLowering') {}

test('domain setup waits for promotion even when a redeploy keeps a stable deployment id', async () => {
  const events: string[] = [];
  const client = {
    GET: async (path: string) => {
      const data =
        path === '/v1/projects/{id}' ? { data: { workspace: { id: 'wksp_test' } } } : { data: [] };
      return { data, response: Response.json(data) };
    },
    POST: async () => {
      events.push('register');
      expect(events.at(-2)).toBe('promoted');
      const error = { error: { code: 'domain-ownership-required' } };
      return { error, response: Response.json(error, { status: 422 }) };
    },
  } as unknown as ManagementApiClient;
  const providers = Layer.effect(
    TestProviders,
    Provider.collection([Prisma.Deployment, CustomDomain]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Provider.effect(CustomDomain, Effect.succeed(customDomainProviderService(client))),
        Provider.effect(
          Prisma.Deployment,
          Effect.succeed({
            list: () => Effect.succeed([]),
            stables: ['deploymentId'],
            diff: () => Effect.succeed({ action: 'update' as const }),
            reconcile: () =>
              Effect.gen(function* () {
                yield* Effect.sleep('10 millis');
                events.push('promoted');
                return {
                  deploymentId: 'cpv_same',
                  appEndpointDomain: 'https://generated.example.com',
                } as Prisma.Deployment['Attributes'];
              }),
            delete: () => Effect.void,
          }),
        ),
      ),
    ),
  );
  const options = { providers, state: inMemoryState(), dev: false };
  const stack = Core.scratchStack(options, 'domain-lowering');
  const descriptor = computeDescriptor(() => ({
    workspaceId: 'wksp_test',
    providerParams: new Map(),
    pointerUpdatedAt: () => undefined,
    domains: { main: { web: ['example.com'] }, staging: { web: ['staging.example.com'] } },
  }));
  const context = {
    id: 'web',
    address: 'web',
    application: {
      projectId: 'proj_test',
      branchId: 'br_staging',
      defaultBranchId: undefined,
      branchless: false,
      domainBranchName: 'staging',
    },
  } as unknown as LowerContext;
  const program = descriptor.deploy(
    context,
    {
      serviceId: Output.asOutput('cps_test'),
      endpointDomain: Output.asOutput('https://generated.example.com'),
      projectId: 'proj_test',
    },
    { path: '/tmp/unused.tar.gz', sha256: 'unused' },
    { environment: [], triggers: {}, pointers: [], port: 3000 },
  );
  const tested = program as Effect.Effect<LoweredResult, unknown, never>;
  await Core.run(
    Effect.gen(function* () {
      const first = yield* stack.deploy(tested);
      expect(first.entities).toHaveLength(2);
      expect(first.entities[1]).toMatchObject({
        kind: 'custom-domain',
        id: 'staging.example.com',
        details: { status: 'Setup required' },
      });
      events.length = 0;
      yield* stack.deploy(tested);
      expect(events).toEqual(['promoted', 'register']);
    }),
    options,
  );
});
