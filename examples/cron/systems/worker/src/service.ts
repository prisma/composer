import { compute } from '@prisma/app-cloud';
import node from '@prisma/app-node';
import { workerContract } from './contract.ts';

export default compute({
  name: 'worker',
  deps: {},
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: workerContract },
});
