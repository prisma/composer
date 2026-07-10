import { service } from '@prisma/app';

export default service({
  name: 'fixture-service',
  pack: 'test/pack',
  type: 'fixture/service',
  inputs: {},
  params: {},
  build: {
    kind: 'node',
    assembler: '@prisma/app-node/assemble',
    module: import.meta.url,
    entry: 'server.js',
  },
});
