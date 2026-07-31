export interface StoredQueueMessage {
  readonly id: string;
  readonly queue: string;
  readonly body: unknown;
  readonly attempt: number;
  readonly enqueuedAt: string;
}

export interface LeasedQueueMessage {
  readonly message: StoredQueueMessage;
  readonly leaseToken: string;
}

export interface QueueRuntimeConfiguration {
  readonly name: string;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export type QueueReleaseOutcome = 'retrying' | 'failed' | 'lost';

export interface QueueStore {
  enqueue(input: {
    readonly queue: string;
    readonly body: unknown;
    readonly enqueueKey: string;
  }): Promise<{ id: string }>;
  claim(leaseSeconds: number): Promise<LeasedQueueMessage | null>;
  complete(messageId: string, leaseToken: string): Promise<boolean>;
  release(messageId: string, leaseToken: string): Promise<QueueReleaseOutcome>;
}
