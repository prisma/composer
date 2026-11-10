import { appRoot, service } from '@internal/core';

const fixtureService = service({
  name: 'fixture-js-ext-service',
  extension: 'test/pack',
  type: 'fixture/service',
  inputs: {},
  params: {},
  build: {
    extension: 'test/build',
    type: 'node',
    module: import.meta.url,
    entry: 'server.js',
  },
});

export default appRoot('fixture-js-ext-root', ({ provision }) => {
  provision(fixtureService);
});
