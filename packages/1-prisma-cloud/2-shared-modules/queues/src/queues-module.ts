import type { ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import { postgres } from '@internal/prisma-cloud';
import { queueControlContract, queueProducerContract } from './contracts.ts';
import type { QueueDefinitions } from './definitions.ts';
import { queueService } from './queue-service.ts';

/** Provisions the durable queue database and the service that owns it. */
export function queues(opts: {
  readonly definitions: QueueDefinitions;
  readonly name?: string;
}): ModuleNode<
  Record<never, never>,
  { producer: typeof queueProducerContract; dispatch: typeof queueControlContract },
  Record<never, never>
> {
  return module(
    opts.name ?? 'queues',
    { expose: { producer: queueProducerContract, dispatch: queueControlContract } },
    ({ provision }) => {
      const db = provision(postgres({ name: 'db' }), { id: 'db' });
      const service = provision(queueService(), {
        id: 'service',
        deps: { db },
        input: {
          queues: Object.entries(opts.definitions).map(([name, definition]) => ({
            name,
            maxAttempts: definition.retry?.maxAttempts ?? 5,
            retryDelayMs: (definition.retry?.delay?.delaySeconds ?? 5) * 1000,
          })),
        },
      });
      return { producer: service.producer, dispatch: service.dispatch };
    },
  );
}
