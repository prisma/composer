/**
 * The reusable scheduler node and its firing logic. `cronScheduler` builds a
 * `compute()` whose one input is the `jobs` schedule (bound at provision by
 * `cron()`, ADR-0042) and whose only dependency is `trigger(jobId)`; nothing
 * else about it varies per app. `runScheduler` is the pure, injectable firing
 * loop the entrypoint (and its tests) drive.
 */
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { rpc } from '@internal/service-rpc';
import { type } from 'arktype';
import { triggerContract } from './contract.ts';
import { parseEvery } from './schedule.ts';

const cronInputSchema = type({ jobs: type({ jobId: 'string', every: 'string' }).array() });

/**
 * The always-on scheduler service. Job-agnostic: the schedule arrives as the
 * `jobs` key of the input binding `cron()` supplies at provision, and the
 * entrypoint reads it back through `input()`.
 */
export function cronScheduler() {
  return compute({
    name: 'scheduler',
    deps: { trigger: rpc(triggerContract) },
    input: cronInputSchema,
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
