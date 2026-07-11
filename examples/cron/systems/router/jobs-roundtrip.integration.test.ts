/// <reference types="bun" />
/**
 * Proves S1's structured `jobs` param survives deploy-encode -> boot-decode
 * -> config() unchanged: `bootstrapService` stashes the schedule's `jobs`
 * array into the process env with the exact `stash` a deploy boot uses, then
 * a freshly constructed scheduler node — reading the same address-free env
 * keys, per S1's address-free stash — reads it back through `config()`. Run
 * via `bun test` (needs `bootstrapService`'s env write, not vitest).
 */
import { describe, expect, test } from 'bun:test';
import { bootstrapService } from '@prisma/app-cloud/testing';
import { cronScheduler } from '@prisma/app-cron';
import { schedule } from './src/schedule.ts';

const PORT = 4501;

describe('cronScheduler jobs param: deploy-encode -> boot-decode -> config()', () => {
  test('jobs round-trips unchanged; trigger hydrates to a callable client', async () => {
    let jobsAfterBoot: ReadonlyArray<{ jobId: string; every: string }> = [];
    let triggerFn: ((input: { jobId: string }) => Promise<{ ok: boolean }>) | undefined;

    await bootstrapService(
      cronScheduler(schedule),
      {
        service: { jobs: schedule.jobs, port: PORT },
        inputs: { trigger: { url: 'http://localhost:1/' } },
      },
      async () => {
        const freshScheduler = cronScheduler(schedule);
        jobsAfterBoot = freshScheduler.config().jobs;
        triggerFn = freshScheduler.load().trigger.trigger;
      },
    );

    expect(jobsAfterBoot).toEqual(schedule.jobs);
    expect(typeof triggerFn).toBe('function');
  });
});
