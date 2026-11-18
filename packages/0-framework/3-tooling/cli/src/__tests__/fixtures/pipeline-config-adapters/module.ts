import { appRoot, module, service } from '@internal/core';

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

const greetingInput = {
  '~standard': {
    version: 1 as const,
    vendor: 'fixture',
    types: { input: { greeting: '' }, output: { greeting: '' } },
    validate: (value: unknown) =>
      typeof value === 'object' && value !== null && 'greeting' in value
        ? { value: { greeting: String(value.greeting) } }
        : { issues: [{ message: 'greeting is required' }] },
  },
};

const rootInput = {
  '~standard': {
    version: 1 as const,
    vendor: 'fixture',
    types: { input: { CONFIG_POOL_PROBE: '' }, output: { CONFIG_POOL_PROBE: '' } },
    validate: (value: unknown) =>
      typeof value === 'object' && value !== null && 'CONFIG_POOL_PROBE' in value
        ? { value: { CONFIG_POOL_PROBE: String(value.CONFIG_POOL_PROBE) } }
        : { issues: [{ message: 'CONFIG_POOL_PROBE is required' }] },
  },
};

const greeter = module('greeter', { input: greetingInput }, ({ input, provision }) => {
  provision(echo, { input: { greeting: input.greeting } });
});

export default appRoot(
  'pipeline-config-adapters-fixture',
  { input: rootInput },
  ({ input, provision }) => {
    provision(greeter, { input: { greeting: input.CONFIG_POOL_PROBE } });
  },
);
