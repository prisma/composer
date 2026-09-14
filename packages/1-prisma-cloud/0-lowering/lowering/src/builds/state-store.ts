/**
 * Wraps a state store so every resource it records is also reported to the
 * build this run belongs to. The store's behaviour is unchanged: reporting
 * hangs off a successful write and can only ever add a request.
 */
import type { PersistedState, StateService } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import type { BuildsApi } from './api.ts';
import { type ResourceReporter, resourceReporter } from './resources.ts';

export interface ReportingStateStore {
  readonly store: StateService;
  readonly reporter: ResourceReporter;
}

/**
 * Reports on the way out of a successful `set`, never before it: a write that
 * failed leaves the resource unrecorded here, and claiming otherwise would
 * make the build's provenance a guess.
 */
export function withResourceReporting(
  inner: StateService,
  api: BuildsApi,
  buildId: string,
  warn?: (message: string) => void,
): ReportingStateStore {
  const reporter = resourceReporter(api, buildId, warn);

  const store: StateService = {
    ...inner,
    set<V extends PersistedState>(request: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) {
      return inner
        .set(request)
        .pipe(Effect.tap(() => Effect.sync(() => reporter.observe(request.value))));
    },
  };

  return { store, reporter };
}
