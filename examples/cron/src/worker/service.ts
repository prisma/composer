import { compute } from '@prisma/compose-cloud';
import node from '@prisma/compose-node';
import { workerContract } from './contract.ts';

export default compute({
  name: 'worker',
  deps: {},
  build: node({ module: import.meta.url, entry: '../../dist/worker/server.mjs' }),
  expose: { rpc: workerContract },
});
