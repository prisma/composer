import { appRoot, service } from '@internal/core';

const makeService = (name: string) =>
  service({
    name,
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

export default appRoot('fixture-root', ({ provision }) => {
  provision(makeService('one'), { id: 'one' });
  provision(makeService('two'), { id: 'two' });
});
