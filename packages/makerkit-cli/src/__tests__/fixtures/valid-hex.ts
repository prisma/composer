import { hex, service } from '@makerkit/core';

const makeService = (name: string) =>
  service({
    name,
    pack: 'test/pack',
    type: 'fixture/service',
    inputs: {},
    params: {},
    build: { kind: 'node', module: import.meta.url, entry: 'server.js' },
  });

export default hex('fixture-hex', (h) => {
  h.provision('one', makeService('one'));
  h.provision('two', makeService('two'));
});
