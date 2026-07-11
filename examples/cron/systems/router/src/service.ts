import { workerContract } from '@cron/worker/contract';
import { compute } from '@prisma/app-cloud';
import { triggerContract } from '@prisma/app-cron';
import node from '@prisma/app-node';
import { rpc } from '@prisma/app-rpc';

export default compute({
  name: 'router',
  deps: { worker: rpc(workerContract) },
  build: node({ module: import.meta.url, entry: '../dist/router-entry.mjs' }),
  expose: { trigger: triggerContract },
});
