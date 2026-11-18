/** The messages between `prisma dev`'s main thread and its converge worker. */
import type { ConvergeEvent } from '../converge-in-process.ts';
import type { DevConvergeResult } from './dev-converge.ts';

/** From the main thread: stop the converge. */
export interface AbortMessage {
  readonly kind: 'abort';
}

/** From the worker, in order: any number of `event` and `output`, then one `result`. */
export type WorkerMessage =
  | { readonly kind: 'event'; readonly event: ConvergeEvent }
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'result'; readonly result: DevConvergeResult };

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
    case 'result':
      return isRecord(value['result']) && typeof value['result']['kind'] === 'string';
    default:
      return false;
  }
}
