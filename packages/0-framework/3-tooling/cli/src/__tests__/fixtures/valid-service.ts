import { service } from '@internal/core';

export default service({
  name: 'fixture-service',
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
