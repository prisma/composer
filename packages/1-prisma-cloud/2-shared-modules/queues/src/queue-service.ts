import node from '@internal/node';
import { compute, postgres } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { queueControlContract, queueProducerContract } from './contracts.ts';

const queueServiceInput = type({
  queues: type({
    name: 'string',
    maxAttempts: '1 <= number.integer <= 100',
    retryDelayMs: '1000 <= number.integer <= 86400000',
  }).array(),
});

export function queueService() {
  return compute({
    name: 'queues',
    deps: { db: postgres() },
    input: queueServiceInput,
    expose: { producer: queueProducerContract, dispatch: queueControlContract },
    build: node({
      module: new URL('./queue-service.mjs', import.meta.url).href,
      entry: './queue-entrypoint.mjs',
    }),
  });
}

export default queueService();
