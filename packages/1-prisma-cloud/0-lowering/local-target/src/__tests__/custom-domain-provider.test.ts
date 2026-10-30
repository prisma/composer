/** A `Prisma.CustomDomain` under the local providers and the real Alchemy apply engine. */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ContainerInstance, LocalTargetProvidersInput } from '@internal/core/config';
import * as Prisma from 'alchemy/Prisma';
import * as State from 'alchemy/State';
import { inMemoryState } from 'alchemy/State/InMemoryState';
import * as Core from 'alchemy/Test/Core';
import * as Effect from 'effect/Effect';
import { localTargetProviders } from '../providers.ts';

const container: ContainerInstance = {
  input: { appName: 'shop', environment: 'dev' },
  serialize: () => 'x',
};
const input: LocalTargetProvidersInput = {
  container,
  devDir: '/nonexistent/.prisma-composer/dev/dev',
  pools: { config: {}, secrets: {} },
};

/** The stack program, with the provider requirement that `localTargetProviders`' erased layer satisfies. */
const programFor = (hostname: string) =>
  Prisma.CustomDomain(`shop.site.domain.${hostname}`, {
    app: 'local-app',
    hostname,
  }) as unknown as Effect.Effect<Prisma.CustomDomain['Attributes']>;
const program = programFor('shop.com');

describe('a custom domain under the local providers', () => {
  afterEach(() => mock.restore());

  test('calls nothing, records the hostname as active with no DNS records, and converges on a second deploy', async () => {
    const fetch = spyOn(globalThis, 'fetch');
    const options = { providers: localTargetProviders(input), state: inMemoryState(), dev: false };
    const stack = Core.scratchStack(options, 'local-custom-domain');

    const first = await Core.run(stack.deploy(program), options);
    const second = await Core.run(stack.deploy(program), options);

    expect(first).toMatchObject({
      customDomainId: 'local-shop.site.domain.shop.com',
      hostname: 'shop.com',
      appId: 'local-app',
      status: 'active',
      dnsRecords: [],
    });
    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a hostname change creates the new custom domain and removes the old one, calling nothing', async () => {
    const fetch = spyOn(globalThis, 'fetch');
    const options = { providers: localTargetProviders(input), state: inMemoryState(), dev: false };
    const stack = Core.scratchStack(options, 'local-custom-domain-change');

    await Core.run(stack.deploy(programFor('shop.com')), options);
    const changed = await Core.run(stack.deploy(programFor('new.shop.com')), options);

    expect(changed).toMatchObject({
      customDomainId: 'local-shop.site.domain.new.shop.com',
      hostname: 'new.shop.com',
    });
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* yield* State.State;
        return yield* state.list({ stack: stack.name, stage: stack.stage });
      }).pipe(Effect.provide(stack.state)),
    );
    expect(stored).toEqual(['shop.site.domain.new.shop.com']);
    expect(fetch).not.toHaveBeenCalled();
  });
});
