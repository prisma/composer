/**
 * Composes the reusable cron scheduler with the app's job `runner`, firing
 * `schedule` against it. Provision this instead of the scheduler directly, so
 * a native platform timer can later replace the always-on scheduler without
 * changing app code.
 */
import type { Deps, ModuleNode, Params, ServiceNode } from '@internal/core';
import { module } from '@internal/core';
import type { TriggerContract } from './contract.ts';
import type { Schedule } from './schedule.ts';
import { cronScheduler } from './scheduler.ts';

/**
 * `opts.runner` is a service exposing `{ trigger }`; the returned module
 * provisions it alongside the scheduler that fires `opts.schedule` at it. The
 * module's boundary deps mirror the runner's own deps, so the parent wires the
 * real work target through them, e.g.
 * `provision(cron({ schedule, runner }), { worker: worker.rpc })`. `opts.name`
 * sets the module name (default `'cron'`). Exposes nothing.
 */
export function cron<RD extends Deps, RP extends Params, Ids extends string>(opts: {
  schedule: Schedule<Ids>;
  runner: ServiceNode<RD, RP, { trigger: TriggerContract }>;
  name?: string;
}): ModuleNode<RD, Record<never, never>> {
  return module(opts.name ?? 'cron', { deps: opts.runner.inputs }, ({ inputs, provision }) => {
    const runner = provision(opts.runner, { id: 'runner', deps: inputs });
    provision(cronScheduler(opts.schedule), { id: 'scheduler', deps: { trigger: runner.trigger } });
    return {};
  });
}
