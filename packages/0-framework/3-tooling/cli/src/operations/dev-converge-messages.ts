/** The messages between `prisma dev`'s main thread and its converge worker. */
import type { ConvergeEvent, ConvergeOutcome } from '../converge-in-process.ts';

/** From the main thread: stop the converge. */
export interface AbortMessage {
  readonly kind: 'abort';
}

/** From the worker, in order: any number of `event` and `output`, then one `outcome`. */
export type WorkerMessage =
  | { readonly kind: 'event'; readonly event: ConvergeEvent }
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'outcome'; readonly outcome: ConvergeOutcome };

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isAbortMessage(value: unknown): value is AbortMessage {
  return isRecord(value) && value['kind'] === 'abort';
}

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'event':
      return isRecord(value['event']);
    case 'output':
      return typeof value['text'] === 'string';
    case 'outcome':
      return isRecord(value['outcome']) && typeof value['outcome']['kind'] === 'string';
    default:
      return false;
  }
}
