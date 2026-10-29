import { expect, test } from 'bun:test';
import * as Provider from 'alchemy/Provider';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import { prismaCloud } from '../control/extension.ts';
import { deploymentArtifactProviderService } from '../deployment-artifact.ts';
import type { EnvironmentSetApi } from '../environment-set-api.ts';

function harness(releaseStatus = 200) {
  const calls: string[] = [];
  const api = {
    PUT: async () => {
      calls.push('record');
      return {
        data: {
          data: {
            id: 'cpv_1',
            artifactHash: 'a'.repeat(64),
            consoleUrl: 'https://console.prisma.io/retained-attempt',
          },
        },
        response: new Response(null, { status: 200 }),
      };
    },
    POST: async () => {
      calls.push('release');
      return {
        ...(releaseStatus === 200
          ? { data: { data: { serviceEndpointDomain: 'https://app.example' } } }
          : {}),
        response: new Response(null, { status: releaseStatus }),
      };
    },
  } as unknown as EnvironmentSetApi;
  return { calls, service: deploymentArtifactProviderService(api) };
}
const news = {
  deploymentId: 'cpv_1',
  artifactHash: 'a'.repeat(64),
  requiredEnvironmentVariables: ['TOKEN'],
  release: true,
};

test('records the completed upload before releasing it', async () => {
  const { calls, service } = harness();
  const result = await Effect.runPromise(service.reconcile({ news } as never));
  expect(calls).toEqual(['record', 'release']);
  expect(result).toMatchObject({
    deploymentId: 'cpv_1',
    serviceEndpointDomain: 'https://app.example',
  });
});

test('a failed release keeps the receipt and links directly to the retained attempt', async () => {
  const { calls, service } = harness(409);
  const released = Effect.runPromise(service.reconcile({ news } as never));
  await expect(released).rejects.toThrow('could not start');
  await expect(released).rejects.toThrow('https://console.prisma.io/retained-attempt');
  expect(calls).toEqual(['record', 'release']);
  expect(await Effect.runPromise(service.delete({} as never))).toBeUndefined();
  expect(calls).toEqual(['record', 'release']);
});

test('the cloud provider bundle resolves the artifact provider before any deployment exists', async () => {
  const providers = prismaCloud().providers!();
  const resolved = await Effect.runPromise(
    Effect.scoped(
      Layer.build(providers).pipe(
        Effect.flatMap((context) =>
          Effect.provideContext(
            Provider.tryFindProviderByType('PrismaComposer.DeploymentArtifact'),
            context,
          ),
        ),
      ),
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PRISMA_SERVICE_TOKEN: 'test-token' })),
      ),
    ),
  );
  expect(Option.isSome(resolved)).toBe(true);
});
