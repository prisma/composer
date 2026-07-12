/**
 * serveSchedule(service, schedule, handlers) is serve() specialized to the
 * cron trigger contract: the single exposed `trigger` method dispatches
 * internally on `jobId` to the schedule's handler map, which `handlers` must
 * cover exactly — the same exhaustiveness serve() enforces over a service's
 * exposed methods, but sourced from the schedule's job ids instead of the
 * contract's methods.
 */
import type { Deps, HydratedDeps, Params, RunnableServiceNode } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { Handlers } from '@internal/rpc';
import { serve } from '@internal/rpc';
import type { TriggerContract } from './contract.ts';
import type { Schedule } from './schedule.ts';

type ScheduleHandler<D> = (deps: D) => Promise<unknown>;

export function serveSchedule<D extends Deps, P extends Params, Ids extends string>(
  service: RunnableServiceNode<D, P, { trigger: TriggerContract }>,
  _schedule: Schedule<Ids>,
  handlers: { [Id in Ids]: ScheduleHandler<HydratedDeps<D>> },
): (req: Request) => Promise<Response> {
  const byId = blindCast<
    Record<string, ScheduleHandler<unknown>>,
    "handlers is the exhaustive typed map keyed by the schedule's Ids; dispatch indexes it by the runtime jobId string"
  >(handlers);

  const triggerHandler = async (
    input: { jobId: string },
    deps: HydratedDeps<D>,
  ): Promise<{ ok: boolean }> => {
    const handler = byId[input.jobId];
    if (handler === undefined) {
      throw new Error(
        `serveSchedule(): no handler for job id "${input.jobId}" — not in the schedule.`,
      );
    }
    await handler(deps);
    return { ok: true };
  };

  return serve(
    service,
    blindCast<
      Handlers<typeof service>,
      "Handlers<S> can't be verified against S while S stays an unresolved type parameter here (TS can't project a mapped type over an unfixed generic); triggerHandler above is hand-typed to triggerContract's exact input/output shape, and the exhaustiveness guarantee serveSchedule promises callers comes from this function's own `handlers` parameter type, not from this internal call"
    >({ trigger: { trigger: triggerHandler } }),
  );
}
