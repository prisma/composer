import { describe, expect, test } from 'bun:test';
import { Load, LoadError, module } from '@internal/core';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { contract, rpc } from '@internal/rpc';
import { type } from 'arktype';
import { triggerContract } from '../contract.ts';
import { cron } from '../module.ts';
import { defineSchedule } from '../schedule.ts';

const build = node({ module: import.meta.url, entry: '../dist/service.mjs' });

const workerContract = contract({
  work: rpc({ input: type({ jobId: 'string' }), output: type({ ok: 'boolean' }) }),
});

const worker = () =>
  compute({
    name: 'worker',
    deps: {},
    build,
    expose: { work: workerContract },
  });

const runner = () =>
  compute({
    name: 'runner',
    deps: { worker: rpc(workerContract) },
    build,
    expose: { trigger: triggerContract },
  });

const schedule = defineSchedule({ tick: '2s' });

describe('cron()', () => {
  test('Loads a graph with the provisioned runner and scheduler, wired to each other and to the worker', () => {
    const root = module('root', {}, ({ provision }) => {
      const w = provision(worker(), { id: 'worker' });
      provision(cron({ schedule, runner: runner() }), { id: 'cron', deps: { worker: w.work } });
      return {};
    });

    const graph = Load(root);
    const ids = graph.nodes.map((n) => n.id);

    expect(ids).toContain('cron.runner');
    expect(ids).toContain('cron.scheduler');
    expect(graph.edges).toContainEqual({
      from: 'worker',
      to: 'cron.runner',
      input: 'worker',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'cron.runner',
      to: 'cron.scheduler',
      input: 'trigger',
      kind: 'dependency',
    });
  });

  test("an invalid wiring — the runner's own dep left unwired into the cron module — throws at Load", () => {
    const root = module('root', {}, ({ provision }) => {
      provision(worker(), { id: 'worker' });
      // The cron module's boundary dep ("worker", mirroring the runner's own
      // dep) is never wired — bypasses the compile-time check the same way
      // module-composition.test.ts's own error-case tests do, to exercise
      // Load's runtime backstop.
      provision(cron({ schedule, runner: runner() }), { id: 'cron', deps: {} as never });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      'Dependency input "worker" of provisioned module "cron" is not wired to a producer (module "root").',
    );
  });
});
