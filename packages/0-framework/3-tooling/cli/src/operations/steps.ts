/**
 * Step events for the operations that converge (`deploy` and `dev`): a
 * tracker that times each step and closes what is left open, and the one
 * mapping from Alchemy's converge events to resource steps both share.
 */
import type { ConvergeEvent } from '../converge-in-process.ts';
import { withComposerAdvice } from '../deployment-summary.ts';

/** A step event, over the operation's own step type. */
export type StepEvent<Step> =
  | { readonly kind: 'step-started'; readonly step: Step }
  | {
      readonly kind: 'message';
      readonly severity: 'info' | 'warn' | 'verbose';
      /** A line Alchemy logged while it planned or applied. */
      readonly text: string;
    }
  | {
      readonly kind: 'step-finished';
      readonly step: Step;
      readonly outcome: 'ok' | 'failed';
      readonly durationMs: number;
      /** What the step measured, as its build adapter or deploy target reported it. The fields vary by adapter and target. */
      readonly data?: Readonly<Record<string, string | number>> | undefined;
    };

/** One resource Alchemy is touching, as a converge event names it. */
export interface ResourceStatus {
  readonly fqn: string;
  readonly resourceType: string;
  readonly status: string;
}

/**
 * Times each step for the host's `onEvent`. Steps are matched by `keyOf`, so
 * a step can finish under a newer status than it started with. A host
 * `onEvent` that throws is the host's bug and cannot fail the operation.
 */
export function stepTracker<Step>(
  keyOf: (step: Step) => string,
  onEvent: ((event: StepEvent<Step>) => void) | undefined,
) {
  const open = new Map<string, { readonly step: Step; readonly startedAt: number }>();
  const emit = (event: StepEvent<Step>): void => {
    try {
      onEvent?.(event);
    } catch {
      // Rendering is the host's; its failures are not the operation's.
    }
  };
  const finish = (
    step: Step,
    outcome: 'ok' | 'failed',
    data?: Readonly<Record<string, string | number>>,
  ): void => {
    const entry = open.get(keyOf(step));
    if (entry === undefined) return;
    open.delete(keyOf(step));
    const durationMs = Math.round(performance.now() - entry.startedAt);
    emit({ kind: 'step-finished', step, outcome, durationMs, data });
  };
  return {
    start(step: Step): void {
      open.set(keyOf(step), { step, startedAt: performance.now() });
      emit({ kind: 'step-started', step });
    },
    finish(step: Step, data?: Readonly<Record<string, string | number>>): void {
      finish(step, 'ok', data);
    },
    fail(step: Step): void {
      finish(step, 'failed');
    },
    /** Closes every open step with `outcome`, innermost first. */
    closeOpen(outcome: 'ok' | 'failed'): void {
      for (const { step } of [...open.values()].reverse()) finish(step, outcome);
    },
    isOpen(step: Step): boolean {
      return open.has(keyOf(step));
    },
    message(severity: 'info' | 'warn' | 'verbose', text: string): void {
      emit({ kind: 'message', severity, text });
    },
  };
}

export type StepTracker<Step> = ReturnType<typeof stepTracker<Step>>;

/** One converge event as step events: each resource is a step, made by `resourceStep`; a log line is a message. */
export function reportConvergeEvent<Step>(
  steps: StepTracker<Step>,
  event: ConvergeEvent,
  redact: (text: string) => string,
  resourceStep: (resource: ResourceStatus) => Step,
): void {
  if (event.kind === 'log') {
    steps.message(event.severity, redact(withComposerAdvice(event.text)));
    return;
  }
  const step = resourceStep({
    fqn: event.fqn,
    resourceType: event.resourceType,
    status: event.status,
  });
  switch (event.phase) {
    case 'running':
      if (!steps.isOpen(step)) steps.start(step);
      return;
    case 'done':
      if (!steps.isOpen(step)) steps.start(step);
      steps.finish(step);
      return;
    case 'failed':
      if (!steps.isOpen(step)) steps.start(step);
      steps.fail(step);
      if (event.message !== undefined) {
        steps.message('warn', redact(`${event.fqn}: ${withComposerAdvice(event.message)}`));
      }
      return;
    case 'pending':
      return;
  }
}
