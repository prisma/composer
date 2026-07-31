import type { RpcHandlerContext } from '@internal/service-rpc';
import type { QueueStore } from '../queue-store.ts';

export function createQueueHandlers(opts: {
  readonly store: QueueStore;
  readonly queueNames: readonly string[];
}) {
  const knownQueues = new Set(opts.queueNames);

  return {
    send: async (
      input: { queue: string; body: unknown },
      _deps: unknown,
      context: RpcHandlerContext,
    ): Promise<{ id: string }> => {
      if (!knownQueues.has(input.queue)) {
        throw new Error(`unknown queue "${input.queue}"`);
      }
      return opts.store.enqueue({
        queue: input.queue,
        body: input.body,
        enqueueKey: context.idempotencyKey ?? crypto.randomUUID(),
      });
    },
    claim: async (input: { leaseSeconds: number }) => {
      const leased = await opts.store.claim(input.leaseSeconds);
      return leased === null
        ? { message: null }
        : { message: leased.message, leaseToken: leased.leaseToken };
    },
    complete: async (input: { messageId: string; leaseToken: string }) => ({
      ok: await opts.store.complete(input.messageId, input.leaseToken),
    }),
    release: async (input: { messageId: string; leaseToken: string }) => ({
      outcome: await opts.store.release(input.messageId, input.leaseToken),
    }),
  };
}
