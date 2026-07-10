import { dependency, service } from '@prisma/app';

export default service({
  name: 'fixture-service-with-unwired-input',
  pack: 'test/pack',
  type: 'fixture/service',
  inputs: {
    auth: dependency({
      type: 'fixture/connection',
      connection: { params: {}, hydrate: () => ({}) },
    }),
  },
  params: {},
  build: {
    kind: 'node',
    assembler: '@prisma/app-node/assemble',
    module: import.meta.url,
    entry: 'server.js',
  },
});
