/// <reference types="bun" />
/**
 * Proves the schedule survives deploy-encode -> boot-decode -> input()
 * unchanged (ADR-0042): `bootstrapService` serializes the `input` binding into
 * the process env with the exact input-document path a deploy uses, then a
 * freshly constructed scheduler node — reading the same address-free row —
 * reads it back through `input()`. Run via `bun test` (needs
 * `bootstrapService`'s env write, not vitest).
 */
import { describe, expect, test } from 'bun:test';
import { cronScheduler } from '@prisma/composer-prisma-cloud/cron';
import { bootstrapService } from '@prisma/composer-prisma-cloud/testing';
import { schedule } from '../src/runner/service.ts';

const PORT = 4501;

describe('cronScheduler jobs input: deploy-encode -> boot-decode -> input()', () => {
  test('jobs round-trips unchanged; trigger hydrates to a callable client', async () => {
    let jobsAfterBoot: ReadonlyArray<{ jobId: string; every: string }> = [];
    let triggerFn: ((input: { jobId: string }) => Promise<{ ok: boolean }>) | undefined;

    await bootstrapService(
      cronScheduler(),
      {
        service: { port: PORT },
        inputs: { trigger: { url: 'http://localhost:1/' } },
        input: { jobs: [...schedule.jobs] },
      },
      async () => {
        // Read through a FRESH scheduler node, exactly as the real entrypoint
        // does (scheduler-entrypoint.ts): the node carries no schedule of its
        // own, so anything input() returns came through the stashed document.
        const freshScheduler = cronScheduler();
        jobsAfterBoot = freshScheduler.input().jobs;
        triggerFn = freshScheduler.load().trigger.trigger;
      },
    );

    expect(jobsAfterBoot).toEqual(schedule.jobs);
    expect(typeof triggerFn).toBe('function');
  });
});
