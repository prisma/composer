import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { queueConsumer, queueProducer } from '@prisma/composer-prisma-cloud/queues';
import { demoQueues } from '../queues.ts';

export default compute({
  name: 'queueDemo',
  deps: { queues: queueProducer(demoQueues) },
  expose: { consumer: queueConsumer() },
  build: node({ module: import.meta.url, entry: '../../dist/app/server.mjs' }),
});
