/**
 * Step events for the operations that converge (`deploy`, `destroy` and `dev`): a
 * tracker that times each step and closes what is left open, and the one
 * mapping from Alchemy's converge events to resource steps both share.
 */
import type { ConvergeEvent } from '../converge-in-process.ts';
import { withComposerAdvice } from '../deployment-summary.ts';
import { type SecretRedaction, StreamRedactor } from '../redaction.ts';

/** The steps a deploy and a destroy both run. */
export type StackStep =
  | { readonly name: 'prepare' | 'assemble' | 'connect' | 'apply' | 'record' }
  | { readonly name: 'assemble-service'; readonly address: string }
  | {
      readonly name: 'apply-resource';
      /** The resource's ID (ADR-0057): its node's address, or the address and the resource's role in that node. */
      readonly resourceId: string;
      readonly resourceType: string;
      /** Alchemy's word for what is happening to the resource, such as `creating` or `created`, for people to read. It changes between a step's start and finish, and its values are Alchemy's, so do not branch on it. */
      readonly status: string;
    };

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
  readonly resourceId: string;
  readonly resourceType: string;
  readonly status: string;
}

/**
 * Times each step for the host's `onEvent`. Steps are matched by `keyOf`, so
 * a step can finish under a newer status than it started with. `emit` sends
 * the operation's other events. A host `onEvent` that throws is the host's
 * bug and cannot fail the operation.
 */
export function stepTracker<Step, OtherEvent = never>(
  keyOf: (step: Step) => string,
  onEvent: ((event: StepEvent<Step> | OtherEvent) => void) | undefined,
) {
  const open = new Map<string, { readonly step: Step; readonly startedAt: number }>();
  const emit = (event: StepEvent<Step> | OtherEvent): void => {
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
    emit,
  };
}

export type StepTracker<Step, OtherEvent = never> = ReturnType<
  typeof stepTracker<Step, OtherEvent>
>;

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
    resourceId: event.fqn,
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

/**
 * Alchemy's terminal text as `info` messages, one per complete line, redacted. A secret split
 * across writes or lines is still found, because the text passes through a `StreamRedactor`
 * before it is cut into lines. `end` sends the last line that has no line break.
 */
export function interactionMessages<Step>(steps: StepTracker<Step>, redaction: SecretRedaction) {
  const stream = new StreamRedactor(redaction.allValues());
  let partial = '';
  const send = (text: string, last: boolean): void => {
    const lines = (partial + text).split('\n');
    partial = last ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (line.trim() !== '') steps.message('info', redaction.redact(line));
    }
  };
  return {
    push: (text: string): void => send(stream.push(text), false),
    end: (): void => send(stream.end(), true),
  };
}
