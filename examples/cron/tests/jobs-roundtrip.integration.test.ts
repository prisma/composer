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
import { cronScheduler } from '@prisma/compose-cloud/cron';
import { bootstrapService } from '@prisma/compose-cloud/testing';
import { schedule } from '../src/runner/service.ts';

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
        // Read through an EMPTY-default scheduler, exactly as the real
        // entrypoint does (scheduler-entrypoint.ts). A full-default node would return
        // schedule.jobs whether or not the env was stashed, so the assertion
        // would pass even if the roundtrip were broken.
        const freshScheduler = cronScheduler<string>({ jobs: [] });
        jobsAfterBoot = freshScheduler.config().jobs;
        triggerFn = freshScheduler.load().trigger.trigger;
      },
    );

    expect(jobsAfterBoot).toEqual(schedule.jobs);
    expect(typeof triggerFn).toBe('function');
  });
});
