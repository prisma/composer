import { hex, service } from '@prisma/app';

const makeService = (name: string) =>
  service({
    name,
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
    targetModule: 'test/pack/target',
  });

export default hex('fixture-hex', {}, ({ provision }) => {
  provision('one', makeService('one'));
  provision('two', makeService('two'));
  return {};
});
