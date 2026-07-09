import { connectionEnd, service } from '@makerkit/core';

export default service({
  name: 'fixture-service-with-unwired-input',
  pack: 'test/pack',
  type: 'fixture/service',
  inputs: {
    auth: connectionEnd({
      type: 'fixture/connection',
      connection: { params: {}, hydrate: () => ({}) },
    }),
  },
  params: {},
  build: { kind: 'node', module: import.meta.url, entry: 'server.js' },
});
