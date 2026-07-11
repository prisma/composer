/// <reference types="bun" />
/**
 * Proof of firing (testing.md § Integration): the real pipeline end to end —
 * defineSchedule -> runScheduler -> the trigger contract over real HTTP ->
 * serveSchedule's jobId dispatch -> the worker. Boots the REAL router entry
 * (`dist/router-entry.mjs`, unmodified) via `bootstrapService` against a fake
 * worker on a loopback `Bun.serve`, then drives `runScheduler` with a fake
 * timer over a real trigger client pointed at the booted router. Timers are
 * deterministic — a fake `setTimer` plus awaiting each `call`'s returned
 * promise — never real wall-clock `setInterval`. Run via `bun test`.
 */
import { describe, expect, test } from 'bun:test';
import { createFakeWorker } from '@cron/worker/fake';
import { bootstrapService } from '@prisma/app-cloud/testing';
import { runScheduler, triggerContract } from '@prisma/app-cron';
import { makeClient } from '@prisma/app-rpc';
import { schedule } from './src/schedule.ts';
import routerService from './src/service.ts';

const ROUTER_PORT = 4502;

describe('cron pipeline: schedule -> runScheduler -> trigger over HTTP -> serveSchedule -> worker', () => {
  test('firing each job reaches the matching worker method through the real router entry', async () => {
    const fakeWorker = createFakeWorker();
    const worker = Bun.serve({ port: 0, fetch: fakeWorker.fetch });

    const router = await bootstrapService(routerService, {
      service: { port: ROUTER_PORT },
      inputs: { worker: { url: worker.url.href } },
    });

    const client = makeClient(triggerContract, router.url);

    const timers: Array<{ fn: () => void; ms: number }> = [];
    let pending: Promise<{ ok: boolean }> = Promise.resolve({ ok: true });

    runScheduler({
      jobs: schedule.jobs,
      call: (jobId) => {
        pending = client.trigger({ jobId });
        return pending;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
      },
    });

    expect(timers).toHaveLength(2);
    expect(timers[0]?.ms).toBe(2_000); // "2s"
    expect(timers[1]?.ms).toBe(5_000); // "5s"

    timers[0]?.fn();
    expect(await pending).toEqual({ ok: true });
    expect(fakeWorker.calls).toEqual(['tick']);

    timers[1]?.fn();
    expect(await pending).toEqual({ ok: true });
    expect(fakeWorker.calls).toEqual(['tick', 'refreshMrr']);
  });
});
