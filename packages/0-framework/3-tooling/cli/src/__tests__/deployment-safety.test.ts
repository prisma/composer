import { describe, expect, test } from 'bun:test';
import type { DestructivePlan } from '@internal/core/config';
import * as Stacks from 'alchemy/Alchemist/routes/stack';
import { StackModuleLoader } from 'alchemy/Alchemist/Session';
import { isResolved } from 'alchemy/Diff';
import * as Output from 'alchemy/Output';
import * as Provider from 'alchemy/Provider';
import { Resource } from 'alchemy/Resource';
import { Stack } from 'alchemy/Stack';
import { inMemoryState } from 'alchemy/State/InMemoryState';
import * as Core from 'alchemy/Test/Core';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { applyGuardedPlan, destructivePlan } from '../guarded-deployment.ts';

interface Owned
  extends Resource<'Test.Owned', { identity: string; hostname?: string }, { id: string }> {}
const Owned = Resource<Owned>('Test.Owned');
class Providers extends Provider.ProviderCollection<Providers>()('GuardTests') {}

function fixture(branch: string) {
  const writes: string[] = [];
  let failDeletion = false;
  const providers = Layer.effect(Providers, Provider.collection([Owned])).pipe(
    Layer.provideMerge(
      Provider.effect(
        Owned,
        Effect.succeed({
          list: () => Effect.succeed([]),
          diff: ({ olds, news }) =>
            Effect.succeed(
              isResolved(news) && olds.identity !== news.identity
                ? { action: 'replace' as const }
                : { action: 'update' as const },
            ),
          reconcile: ({ id, news }) =>
            Effect.sync(() => {
              writes.push(`write ${news.identity}`);
              return { id };
            }),
          delete: ({ output }) =>
            failDeletion
              ? Effect.fail(new Error('Synthetic interrupted replacement cleanup'))
              : Effect.sync(() => {
                  writes.push(`delete ${output.id}`);
                }),
        }),
      ),
    ),
  );
  const options = { providers, state: inMemoryState(), stage: branch, dev: false };
  let resources = [
    { id: 'web', identity: 'app' },
    { id: 'db', identity: 'database' },
    { id: 'domain', identity: 'domain', hostname: 'example.com' },
  ];
  const definition = Stack(
    'guard-tests',
    options,
    Effect.gen(function* () {
      for (const row of resources) yield* Owned(row.id, row);
      return {};
    }),
  );
  const scope = {
    id: `project/${branch}`,
    label: `Project project, branch ${branch}`,
    removalConsequence: 'Delete all branch resources, including externally managed domains.',
  };
  const plan = (operation: 'deploy' | 'destroy' = 'deploy') =>
    Stacks.plan({
      target: { entrypoint: import.meta.path, stage: branch },
      operation,
    }).pipe(
      Effect.provideService(StackModuleLoader, { import: async () => ({ default: definition }) }),
    );
  return {
    options,
    writes,
    failDeletion: (value: boolean) => {
      failDeletion = value;
    },
    scope,
    plan,
    set: (rows: typeof resources) => {
      resources = rows;
    },
  };
}

describe('destructive deployment approval', () => {
  test.each(['main', 'staging'])(
    'refuses the entire plan before any writes on %s',
    async (branch) => {
      const f = fixture(branch);
      await Core.run(
        Effect.gen(function* () {
          yield* Stacks.apply(yield* f.plan());
          f.writes.length = 0;
          f.set([{ id: 'web-renamed', identity: 'new-app' }]);
          const snapshot = yield* f.plan();
          let refused: DestructivePlan | undefined;
          expect(
            yield* applyGuardedPlan(snapshot, {
              scopes: [f.scope],
              safeReplacementTypes: [],
              onRefused: (p) => {
                refused = p;
              },
            }),
          ).toBe(false);
          expect(f.writes).toEqual([]);
          expect(refused?.changes).toHaveLength(3);
          expect(
            refused?.changes.find((c) => c.resource.endsWith('domain'))?.consequence,
          ).toContain('example.com');
          const again = yield* f.plan();
          expect(destructivePlan(again.native, [f.scope], [], again.stack)?.token).toBe(
            refused?.token,
          );
          expect(
            yield* applyGuardedPlan(again, {
              scopes: [f.scope],
              safeReplacementTypes: [],
              approval: refused?.token,
              onRefused: () => {
                throw new Error('same plan should be approved');
              },
            }),
          ).toBe(true);
          expect(f.writes.some((w) => w.startsWith('delete'))).toBe(true);
        }),
        f.options,
      );
    },
  );

  test('stale state, changed target, and replacement identity invalidate approval', async () => {
    const f = fixture('main');
    await Core.run(
      Effect.gen(function* () {
        yield* Stacks.apply(yield* f.plan());
        f.set([{ id: 'db', identity: 'replacement-database' }]);
        const snapshot = yield* f.plan();
        const token = destructivePlan(snapshot.native, [f.scope], [], snapshot.stack)?.token;
        expect(
          destructivePlan(
            snapshot.native,
            [{ ...f.scope, id: 'other-project/main' }],
            [],
            snapshot.stack,
          )?.token,
        ).not.toBe(token);
        f.set([{ id: 'db', identity: 'other-replacement' }]);
        expect(
          destructivePlan((yield* f.plan()).native, [f.scope], [], snapshot.stack)?.token,
        ).not.toBe(token);
        f.set([
          { id: 'web', identity: 'app' },
          { id: 'db', identity: 'database' },
          { id: 'domain', identity: 'domain', hostname: 'example.com' },
        ]);
        yield* Stacks.apply(yield* f.plan());
        f.set([{ id: 'db', identity: 'replacement-database' }]);
        expect(
          destructivePlan((yield* f.plan()).native, [f.scope], [], snapshot.stack)?.token,
        ).not.toBe(token);
      }),
      f.options,
    );
  });

  test('code replacement is automatic, but deletion and container teardown still require approval', async () => {
    const f = fixture('pr-42');
    await Core.run(
      Effect.gen(function* () {
        yield* Stacks.apply(yield* f.plan());
        f.set([
          { id: 'web', identity: 'code-v2' },
          { id: 'db', identity: 'database' },
          { id: 'domain', identity: 'domain', hostname: 'example.com' },
        ]);
        const snapshot = yield* f.plan();
        expect(
          destructivePlan(snapshot.native, [f.scope], ['Test.Owned'], snapshot.stack),
        ).toBeUndefined();
        const destroy = yield* f.plan('destroy');
        const removal = destructivePlan(destroy.native, [f.scope], ['Test.Owned'], destroy.stack);
        expect(removal?.changes.some((c) => c.type === 'deployment-container')).toBe(true);
        f.writes.length = 0;
        expect(
          yield* applyGuardedPlan(destroy, {
            scopes: [f.scope],
            safeReplacementTypes: ['Test.Owned'],
            approval: 'wrong',
            onRefused: () => {},
          }),
        ).toBe(false);
        expect(f.writes).toEqual([]);
        expect(
          yield* applyGuardedPlan(destroy, {
            scopes: [f.scope],
            safeReplacementTypes: [],
            approval: removal?.token,
            onRefused: () => {},
          }),
        ).toBe(true);
      }),
      f.options,
    );
  });
});

test('unresolved replacement inputs are fingerprinted without coercing output proxies', async () => {
  const f = fixture('main');
  await Core.run(
    Effect.gen(function* () {
      yield* Stacks.apply(yield* f.plan());
      f.set([{ id: 'db', identity: 'replacement' }]);
      const snapshot = yield* f.plan();
      const replacement = Object.values(snapshot.native.resources).find(
        (node) => node.action === 'replace',
      );
      if (replacement?.action !== 'replace') throw new Error('expected replacement');
      replacement.props = { identity: Output.literal('first') };
      const token = destructivePlan(snapshot.native, [f.scope], [], snapshot.stack)?.token;
      replacement.props = { identity: Output.literal('second') };
      expect(destructivePlan(snapshot.native, [f.scope], [], snapshot.stack)?.token).not.toBe(
        token,
      );
    }),
    f.options,
  );
});

test('resuming an interrupted durable-resource replacement still requires approval', async () => {
  const f = fixture('main');
  await Core.run(
    Effect.gen(function* () {
      yield* Stacks.apply(yield* f.plan());
      f.set([
        { id: 'web', identity: 'app' },
        { id: 'db', identity: 'replacement' },
        { id: 'domain', identity: 'domain', hostname: 'example.com' },
      ]);
      f.failDeletion(true);
      yield* Effect.exit(Stacks.apply(yield* f.plan()));
      f.failDeletion(false);
      f.writes.length = 0;
      const retry = yield* f.plan();
      const plan = destructivePlan(retry.native, [f.scope], [], retry.stack);
      expect(
        plan?.changes.some(
          (change) => change.resource.endsWith('db') && change.action === 'replace',
        ),
      ).toBe(true);
      expect(
        yield* applyGuardedPlan(retry, {
          scopes: [f.scope],
          safeReplacementTypes: [],
          onRefused: () => {},
        }),
      ).toBe(false);
      expect(f.writes).toEqual([]);
      expect(
        destructivePlan(retry.native, [f.scope], [], { ...retry.stack, stage: 'other-branch' })
          ?.token,
      ).not.toBe(plan?.token);
    }),
    f.options,
  );
});
