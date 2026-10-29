import { module, paramSource, service } from '@internal/core';

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

const greeter = module('greeter', { input: anyInput }, ({ input, provision }) => {
  provision(echo, { input: { greeting: (input as never as { greeting: never }).greeting } });
});

export default module('pipeline-config-pool-fixture', ({ provision }) => {
  provision(greeter, {
    input: {
      greeting: paramSource({ name: 'S3_PIPELINE_PROBE' }, { configKey: 'S3_PIPELINE_PROBE' }),
    },
  });
});
