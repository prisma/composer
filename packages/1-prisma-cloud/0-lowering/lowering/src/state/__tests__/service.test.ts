import { describe, expect, test } from 'bun:test';
import { type PersistedState, type StateService, StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import { guardStateService } from '../service.ts';

/** A stub StateService that records every method it was actually invoked with. */
const makeStubService = (): { readonly service: StateService; readonly calls: string[] } => {
  const calls: string[] = [];
  const record = <A>(name: string, value: A): Effect.Effect<A, StateStoreError, never> =>
    Effect.sync(() => {
      calls.push(name);
      return value;
    });

  const service: StateService = {
    id: 'stub',
    getVersion: () => record('getVersion', 5),
    listStacks: () => record('listStacks', []),
    listStages: () => record('listStages', []),
    get: () => record('get', undefined),
    getReplacedResources: () => record('getReplacedResources', []),
    set: (request) => record('set', request.value),
    delete: () => record('delete', undefined),
    deleteStack: () => record('deleteStack', undefined),
    list: () => record('list', []),
    getOutput: () => record('getOutput', undefined),
    setOutput: (request) => record('setOutput', request.value),
  };

  return { service, calls };
};

const request = { stack: 'stack', stage: 'stage', fqn: 'fqn', value: {} as PersistedState };

describe('guardStateService', () => {
  test('when checkLive fails, every guarded method fails and the underlying service is never invoked', async () => {
    const { service, calls } = makeStubService();
    const checkLive = Effect.fail(new StateStoreError({ message: 'lease lost' }));
    const guarded = guardStateService(service, checkLive);

    await expect(Effect.runPromise(guarded.listStacks())).rejects.toThrow();
    await expect(Effect.runPromise(guarded.listStages('stack'))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.get(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.getReplacedResources(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.set(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.delete(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.deleteStack(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.list(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.getOutput(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.setOutput(request))).rejects.toThrow();

    expect(calls).toEqual([]);
  });

  test('when checkLive passes, every guarded method calls through to the underlying service', async () => {
    const { service, calls } = makeStubService();
    const guarded = guardStateService(service, Effect.void);

    await Effect.runPromise(guarded.listStacks());
    await Effect.runPromise(guarded.listStages('stack'));
    await Effect.runPromise(guarded.get(request));
    await Effect.runPromise(guarded.getReplacedResources(request));
    await Effect.runPromise(guarded.set(request));
    await Effect.runPromise(guarded.delete(request));
    await Effect.runPromise(guarded.deleteStack(request));
    await Effect.runPromise(guarded.list(request));
    await Effect.runPromise(guarded.getOutput(request));
    await Effect.runPromise(guarded.setOutput(request));

    expect(calls).toEqual([
      'listStacks',
      'listStages',
      'get',
      'getReplacedResources',
      'set',
      'delete',
      'deleteStack',
      'list',
      'getOutput',
      'setOutput',
    ]);
  });

  test('getVersion is excluded from the guard — it calls through even when checkLive fails', async () => {
    const { service, calls } = makeStubService();
    const checkLive = Effect.fail(new StateStoreError({ message: 'lease lost' }));
    const guarded = guardStateService(service, checkLive);

    const version = await Effect.runPromise(guarded.getVersion());

    expect(version).toBe(5);
    expect(calls).toEqual(['getVersion']);
  });

  test('id passes through unguarded', () => {
    const { service } = makeStubService();
    const guarded = guardStateService(service, Effect.void);

    expect(guarded.id).toBe(service.id);
  });

  // A checkLive that counts its runs and can be flipped to fail, plus a
  // clock the test drives. Amortization is keyed on wall time, so a fixed
  // clock means "within the TTL window".
  const countingCheck = () => {
    let count = 0;
    let fail = false;
    const checkLive = Effect.suspend(() => {
      count += 1;
      return fail ? Effect.fail(new StateStoreError({ message: 'lease lost' })) : Effect.void;
    });
    return {
      checkLive,
      runs: () => count,
      startFailing: () => {
        fail = true;
      },
    };
  };

  test('amortizes the lease check: a burst of operations inside the TTL window does one round-trip', async () => {
    const { service } = makeStubService();
    const check = countingCheck();
    const guarded = guardStateService(service, check.checkLive, () => 1_000); // clock frozen inside the window

    for (let i = 0; i < 5; i += 1) await Effect.runPromise(guarded.get(request));

    expect(check.runs()).toBe(1);
  });

  test('re-checks after the TTL expires — a lease lost after the window is detected', async () => {
    const { service } = makeStubService();
    const check = countingCheck();
    let clock = 1_000;
    const guarded = guardStateService(service, check.checkLive, () => clock);

    await Effect.runPromise(guarded.get(request)); // passes, caches
    check.startFailing();
    await Effect.runPromise(guarded.get(request)); // still inside TTL — trusted, succeeds
    clock += 6_000; // advance past the 5s TTL
    await expect(Effect.runPromise(guarded.get(request))).rejects.toThrow(); // re-checks, now fails
    expect(check.runs()).toBe(2); // first success + the post-expiry failure
  });

  test('a failing check is never cached — the next op re-checks immediately', async () => {
    const { service } = makeStubService();
    const check = countingCheck();
    check.startFailing();
    const guarded = guardStateService(service, check.checkLive, () => 1_000); // frozen clock

    await expect(Effect.runPromise(guarded.get(request))).rejects.toThrow();
    await expect(Effect.runPromise(guarded.get(request))).rejects.toThrow();

    expect(check.runs()).toBe(2); // no cached success to skip on
  });
});
