import { serve } from '@internal/service-rpc';
import { queueService } from '../queue-service.ts';
import { createQueueHandlers } from './handlers.ts';
import { createPgQueueStore } from './pg-queue-store.ts';

const service = queueService();
const { db } = service.load();
const { queues } = service.input();
const store = await createPgQueueStore(db.url, queues);
console.info(`queue service ready with ${queues.length} queue definition(s)`);
const handlers = createQueueHandlers({
  store,
  queueNames: queues.map((queue) => queue.name),
});

const fetchHandler = serve(service, {
  producer: { send: handlers.send },
  dispatch: {
    claim: handlers.claim,
    complete: handlers.complete,
    release: handlers.release,
  },
});

Bun.serve({ port: service.port(), hostname: '0.0.0.0', fetch: fetchHandler });
