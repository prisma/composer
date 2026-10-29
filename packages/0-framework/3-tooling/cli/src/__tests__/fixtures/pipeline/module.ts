import { module, resolve, service } from '@internal/core';

const anyInput = {
  '~standard': {
    version: 1 as const,
    vendor: 'fixture',
    validate: (value: unknown) => ({ value }),
  },
};

const echo = service({
  name: 'echo',
  extension: 'fixture-extension',
  type: 'fixture/compute',
  inputs: {},
  params: {},
  input: anyInput,
  build: { extension: 'fixture-build', type: 'node', module: import.meta.url, entry: 'server.js' },
});

export default module('pipeline-fixture', ({ environment, provision }) => {
  const label = resolve([environment.name], ([name]) => `deployed to ${name}`);
  provision(echo, { input: { environment: label } });
});
