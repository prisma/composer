import type { Client } from '@internal/service-rpc';
import type { queueConsumerContract, queueControlContract } from '../contracts.ts';

export interface DispatcherClients {
  readonly queue: Client<typeof queueControlContract>;
  readonly consumer: Client<typeof queueConsumerContract>;
}

/** Claims and delivers at most one message. Returns false when the queue is empty. */
export async function dispatchOnce(
  clients: DispatcherClients,
  opts: { readonly leaseSeconds: number },
): Promise<boolean> {
  const claimed = await clients.queue.claim({ leaseSeconds: opts.leaseSeconds });
  if (claimed.message === null) return false;

  try {
    const result = await clients.consumer.deliver(claimed.message);
    if (!result.ok) {
      const released = await clients.queue.release({
        messageId: claimed.message.id,
        leaseToken: claimed.leaseToken,
      });
      if (released.outcome === 'lost') {
        throw new Error(`queue dispatcher lost the lease for message "${claimed.message.id}"`);
      }
      return true;
    }
  } catch (error) {
    const released = await clients.queue.release({
      messageId: claimed.message.id,
      leaseToken: claimed.leaseToken,
    });
    if (released.outcome === 'lost') {
      throw new Error(`queue dispatcher lost the lease for message "${claimed.message.id}"`);
    }
    throw error;
  }

  const completed = await clients.queue.complete({
    messageId: claimed.message.id,
    leaseToken: claimed.leaseToken,
  });
  if (!completed.ok) {
    throw new Error(`queue dispatcher lost the lease for message "${claimed.message.id}"`);
  }
  return true;
}

/** Starts the continuously running delivery loop. */
export function runDispatcher(
  clients: DispatcherClients,
  opts: {
    readonly leaseSeconds: number;
    readonly pollIntervalMs: number;
  },
): void {
  const tick = async (): Promise<void> => {
    let delay = 0;
    try {
      const delivered = await dispatchOnce(clients, opts);
      delay = delivered ? 0 : opts.pollIntervalMs;
    } catch (error) {
      console.error('queue dispatcher delivery failed', error);
      delay = opts.pollIntervalMs;
    }
    setTimeout(() => void tick(), delay);
  };
  void tick();
}
