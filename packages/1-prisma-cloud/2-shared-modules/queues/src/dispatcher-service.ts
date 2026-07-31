import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { rpc } from '@internal/service-rpc';
import { type } from 'arktype';
import { queueConsumerContract, queueControlContract } from './contracts.ts';

const dispatcherInput = type({
  pollIntervalMs: '10 <= number.integer <= 60000',
  leaseSeconds: '1 <= number.integer <= 300',
});

/** The always-running Compute service that moves messages from Postgres to a consumer. */
export function queueDispatcher() {
  return compute({
    name: 'queueDispatcher',
    deps: {
      queue: rpc(queueControlContract),
      consumer: rpc(queueConsumerContract),
    },
    input: dispatcherInput,
    build: node({
      module: new URL('./dispatcher-service.mjs', import.meta.url).href,
      entry: './dispatcher-entrypoint.mjs',
    }),
  });
}

export default queueDispatcher();
