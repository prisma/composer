import { service, system } from '@prisma/app';

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

export default system('fixture-system', {}, ({ provision }) => {
  provision('one', makeService('one'));
  provision('two', makeService('two'));
  return {};
});
