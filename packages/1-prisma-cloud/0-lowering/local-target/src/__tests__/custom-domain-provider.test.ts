/** A `Prisma.CustomDomain` under the local providers and the real Alchemy apply engine. */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ContainerInstance, LocalTargetProvidersInput } from '@internal/core/config';
import * as Prisma from 'alchemy/Prisma';
import { inMemoryState } from 'alchemy/State/InMemoryState';
import * as Core from 'alchemy/Test/Core';
import type * as Effect from 'effect/Effect';
import { localTargetProviders } from '../providers.ts';

const container: ContainerInstance = {
  input: { appName: 'shop', environment: 'dev' },
  serialize: () => 'x',
};
const input: LocalTargetProvidersInput = {
  container,
  devDir: '/nonexistent/.prisma-composer/dev/dev',
};

/** The stack program, with the provider requirement that `localTargetProviders`' erased layer satisfies. */
const program = Prisma.CustomDomain('shop.site.domain.shop-com', {
  app: 'local-app',
  hostname: 'shop.com',
}) as unknown as Effect.Effect<Prisma.CustomDomain['Attributes']>;

describe('a custom domain under the local providers', () => {
  afterEach(() => mock.restore());

  test('calls nothing, records the hostname as active with no DNS records, and converges on a second deploy', async () => {
    const fetch = spyOn(globalThis, 'fetch');
    const options = { providers: localTargetProviders(input), state: inMemoryState(), dev: false };
    const stack = Core.scratchStack(options, 'local-custom-domain');

    const first = await Core.run(stack.deploy(program), options);
    const second = await Core.run(stack.deploy(program), options);

    expect(first).toMatchObject({
      customDomainId: 'local-shop.site.domain.shop-com',
      hostname: 'shop.com',
      appId: 'local-app',
      status: 'active',
      dnsRecords: [],
    });
    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
  });
});
