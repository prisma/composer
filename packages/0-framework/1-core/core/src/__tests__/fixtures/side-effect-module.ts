import { module, service } from '../../index.ts';

// Importing this module must not increment this counter — only Loading the
// module may run the body (the service node itself carries no behavior to run).
export let bodyCallCount = 0;

const svc = service({
  name: 'test-service',
  extension: 'test/pack',
  type: 'fixture/app',
  inputs: {},
  params: {},
  build: {
    extension: '@prisma/compose/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});

export default module('fixture-module', {}, ({ provision }) => {
  bodyCallCount += 1;
  provision(svc, { id: 'app' });
  return {};
});
