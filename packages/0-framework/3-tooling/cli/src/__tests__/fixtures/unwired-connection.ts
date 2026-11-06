import { dependency, module, service } from '@internal/core';

const unwired = service({
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

export default module('fixture-unwired', ({ provision }) => {
  // @ts-expect-error The compiler refuses an unwired dependency; this fixture reaches Load's check.
  provision(unwired, { id: 'svc' });
});
