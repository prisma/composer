import { module } from '@prisma/composer';
import { queueDispatcher, queues } from '@prisma/composer-prisma-cloud/queues';
import appService from './src/app/service.ts';
import { demoQueues } from './src/queues.ts';

export default module('queues-example', ({ provision }) => {
  const queue = provision(queues({ definitions: demoQueues }));
  const app = provision(appService, { deps: { queues: queue.producer } });
  provision(queueDispatcher(), {
    deps: { queue: queue.dispatch, consumer: app.consumer },
    input: { pollIntervalMs: 250, leaseSeconds: 30 },
  });
});
