import { dependency, service } from '@prisma/compose';

export default service({
  name: 'fixture-service-with-unwired-input',
  extension: 'test/pack',
  type: 'fixture/service',
  inputs: {
    auth: dependency({
      type: 'fixture/connection',
      connection: { params: {}, hydrate: () => ({}) },
    }),
  },
  params: {},
  build: {
    extension: 'test/build',
    type: 'node',
    module: import.meta.url,
    entry: 'server.js',
  },
});
