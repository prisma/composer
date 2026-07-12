import { describe, expect, test } from 'bun:test';
import type { DependencyEnd, RunnableServiceNode } from '@internal/core';
import { dependency, service } from '@internal/core';
import { triggerContract } from '../contract.ts';
import { defineSchedule } from '../schedule.ts';
import { serveSchedule } from '../serve-schedule.ts';

interface FakeDeps {
  readonly calls: string[];
}

/**
 * A fake RunnableServiceNode exposing triggerContract — stands in for
 * cronScheduler-callable's runner node. `target` hydrates through a real
 * DependencyEnd (not an override cast), so `load()`'s return is a genuine
 * `Loaded<D, P>`, matching production shape.
 */
function fakeRunnerService(load: () => FakeDeps) {
  const target: DependencyEnd<FakeDeps> = dependency({
    name: 'target',
    type: 'fake/target',
    connection: { params: {}, hydrate: load },
  });
  const node = service({
    name: 'runner',
    extension: 'test/pack',
    type: 'fake/runner-test',
    inputs: { target },
    params: {},
    build: {
      extension: '@fake/adapter',
      type: 'fake',
      module: 'file:///test/service.ts',
      entry: 'x',
    },
    expose: { trigger: triggerContract },
  });

  return {
    ...node,
    run: (_address: string, boot: () => Promise<unknown>) => boot(),
    load: () => ({ target: load() }),
  } as unknown as RunnableServiceNode<
    typeof node.inputs,
    typeof node.params,
    { trigger: typeof triggerContract }
  >;
}

const schedule = defineSchedule({ tick: '2s', mrr: '5s' });

function triggerRequest(jobId: string): Request {
  return new Request('http://cron.internal/rpc/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
}

describe('serveSchedule()', () => {
  test('POST /rpc/trigger with a scheduled jobId reaches only that handler, with the loaded deps', async () => {
    const runnerService = fakeRunnerService(() => ({ calls: [] }));
    const tickCalls: FakeDeps[] = [];
    const mrrCalls: FakeDeps[] = [];
    const handler = serveSchedule(runnerService, schedule, {
      tick: async (deps) => {
        tickCalls.push(deps.target);
      },
      mrr: async (deps) => {
        mrrCalls.push(deps.target);
      },
    });

    const res = await handler(triggerRequest('tick'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(tickCalls).toHaveLength(1);
    expect(mrrCalls).toHaveLength(0);
  });

  test('calls service.load() exactly once, regardless of request count', async () => {
    let loadCalls = 0;
    const runnerService = fakeRunnerService(() => {
      loadCalls += 1;
      return { calls: [] };
    });
    const handler = serveSchedule(runnerService, schedule, {
      tick: async () => undefined,
      mrr: async () => undefined,
    });

    await handler(triggerRequest('tick'));
    await handler(triggerRequest('mrr'));

    expect(loadCalls).toBe(1);
  });

  test('an unknown jobId gets the same error-status contract serve() gives a failing handler', async () => {
    const runnerService = fakeRunnerService(() => ({ calls: [] }));
    const handler = serveSchedule(runnerService, schedule, {
      tick: async () => undefined,
      mrr: async () => undefined,
    });

    const res = await handler(triggerRequest('doesNotExist'));

    expect(res.status).toBe(500);
  });
});
