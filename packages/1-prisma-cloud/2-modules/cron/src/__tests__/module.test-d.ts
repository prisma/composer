/**
 * Type-level tests for cron() (ADR-0020, S2 dispatch 3): the returned
 * module's boundary deps are exactly the runner's own deps, a runner that
 * doesn't expose `{ trigger: triggerContract }` is rejected at compile time,
 * and a runner exposing extra ports beyond `trigger` still type-checks.
 *
 * Type-only (vitest --typecheck, never executed) — mirrors
 * serve-schedule.test-d.ts.
 */
import type { ModuleNode } from '@internal/core';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { contract, rpc } from '@internal/rpc';
import { type } from 'arktype';
import { test } from 'vitest';
import { triggerContract } from '../contract.ts';
import { cron } from '../module.ts';
import { defineSchedule } from '../schedule.ts';

const build = node({ module: import.meta.url, entry: '../dist/service.mjs' });

const workerContract = contract({
  work: rpc({ input: type({ jobId: 'string' }), output: type({ ok: 'boolean' }) }),
});

const runner = compute({
  name: 'runner',
  deps: { worker: rpc(workerContract) },
  build,
  expose: { trigger: triggerContract },
});

const runnerWithExtraPort = compute({
  name: 'runner-with-extra',
  deps: { worker: rpc(workerContract) },
  build,
  expose: { trigger: triggerContract, work: workerContract },
});

const notARunner = compute({
  name: 'not-a-runner',
  deps: {},
  build,
  expose: { work: workerContract },
});

const schedule = defineSchedule({ tick: '2s' });

test("cron() yields a ModuleNode whose boundary deps are exactly the runner's own deps", () => {
  const cronModule = cron({ schedule, runner });
  // Fails to compile unless cron()'s inferred RD is exactly typeof runner.inputs.
  const asRunnerDeps: ModuleNode<typeof runner.inputs, Record<never, never>> = cronModule;
  void asRunnerDeps;
});

test('a runner exposing extra ports beyond trigger still compiles', () => {
  cron({ schedule, runner: runnerWithExtraPort });
});

test('a runner that does not expose { trigger: triggerContract } is rejected', () => {
  // @ts-expect-error notARunner exposes `work`, not the required `trigger`
  cron({ schedule, runner: notARunner });
});
