import node from '@prisma/compose/node';
import { compute } from '@prisma/compose-prisma-cloud';
import { workerContract } from './contract.ts';

export default compute({
  name: 'worker',
  deps: {},
  build: node({ module: import.meta.url, entry: '../../dist/worker/server.mjs' }),
  expose: { rpc: workerContract },
});
