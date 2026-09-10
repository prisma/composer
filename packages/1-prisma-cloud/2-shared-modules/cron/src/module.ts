/**
 * Composes the reusable cron scheduler with the app's job `runner`, firing
 * `schedule` against it. Provision this instead of the scheduler directly, so
 * a native platform timer can later replace the always-on scheduler without
 * changing app code.
 */
import type { Deps, InputBinding, ModuleNode, Params, ServiceNode } from '@internal/core';
import { module } from '@internal/core';
import type { TriggerContract } from './contract.ts';
import type { Schedule } from './schedule.ts';
import { cronScheduler } from './scheduler.ts';

/**
 * The runner's input binding, required exactly when the runner declares an
 * input schema (ADR-0042) — the same rule `provision()` applies to a service.
 */
type RunnerInput<I> = I extends undefined ? { input?: never } : { input: InputBinding };

/**
 * `opts.runner` is a service exposing `{ trigger }`; the returned module
 * provisions it alongside the scheduler that fires `opts.schedule` at it. The
 * module's boundary deps mirror the runner's own deps, so the parent wires the
 * real work target through them, e.g.
 * `provision(cron({ schedule, runner }), { worker: worker.rpc })`. A runner
 * that declares an `input` schema takes its binding as `opts.input`, with
 * `envSecret(...)` leaves where the schema expects secrets. `opts.name` sets
 * the module name (default `'cron'`). Exposes nothing.
 */
export function cron<
  RD extends Deps,
  RP extends Params,
  I extends ServiceNode['inputSchema'],
  Ids extends string,
>(
  opts: {
    schedule: Schedule<Ids>;
    runner: ServiceNode<RD, RP, { trigger: TriggerContract }, I>;
    name?: string;
  } & RunnerInput<I>,
): ModuleNode<RD, Record<never, never>> {
  return module(opts.name ?? 'cron', { deps: opts.runner.inputs }, ({ inputs, provision }) => {
    const runner = provision(opts.runner, {
      id: 'runner',
      deps: inputs,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    provision(cronScheduler(), {
      id: 'scheduler',
      deps: { trigger: runner.trigger },
      input: { jobs: [...opts.schedule.jobs] },
    });
    return {};
  });
}
