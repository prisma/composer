/**
 * The reusable scheduler node and its firing logic. `cronScheduler` builds a
 * `compute()` whose `jobs` param default is the app's schedule and whose only
 * dependency is `trigger(jobId)`; nothing else about it varies per app.
 * `runScheduler` is the pure, injectable firing loop the entrypoint (and its
 * tests) drive.
 */
import { param } from '@internal/core';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { rpc } from '@internal/rpc';
import { type } from 'arktype';
import { triggerContract } from './contract.ts';
import type { Schedule } from './schedule.ts';
import { parseEvery } from './schedule.ts';

const scheduleSchema = type({ jobId: 'string', every: 'string' }).array();

/**
 * The always-on scheduler service. `schedule` sets only the `jobs` param's
 * default — the value the deploy serializes into config; the scheduler
 * itself is job-agnostic.
 */
export function cronScheduler<Ids extends string>(schedule: Schedule<Ids>) {
  return compute({
    name: 'scheduler',
    deps: { trigger: rpc(triggerContract) },
    params: { jobs: param(scheduleSchema, { default: [...schedule.jobs] }) },
    build: node({
      module: new URL('./scheduler-service.mjs', import.meta.url).href,
      entry: './scheduler-entrypoint.mjs',
    }),
  });
}

/**
 * Fires `call(jobId)` on each job's `every` interval. A rejected `call` is
 * logged, never thrown — a missed tick is healed by an idempotent target, not
 * by scheduler state. `setTimer` defaults to `setInterval`; tests inject a
 * fake to drive time.
 */
export function runScheduler(opts: {
  jobs: ReadonlyArray<{ jobId: string; every: string }>;
  call: (jobId: string) => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => void;
}): void {
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));

  for (const job of opts.jobs) {
    const ms = parseEvery(job.every);
    setTimer(() => {
      opts.call(job.jobId).catch((err: unknown) => {
        console.error(`cron: job "${job.jobId}" failed`, err);
      });
    }, ms);
  }
}
