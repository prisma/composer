import type { BuildAdapter, Contract, DependencyEnd } from '@internal/core';
import { service } from '@internal/core';

export const build: BuildAdapter = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

export const otherContract: Contract<'other', undefined> = Object.freeze({
  kind: 'other',
  __cmp: undefined,
  satisfies: (required: Contract<'other', unknown>) => required.kind === 'other',
});

export const provider = <E extends Record<string, Contract<string, unknown>>>(
  name: string,
  expose?: E,
) =>
  service({
    name,
    extension: 'test/pack',
    type: 'compute',
    inputs: {},
    params: {},
    build,
    ...(expose === undefined ? {} : { expose }),
  });

export const consumer = <I extends Record<string, DependencyEnd>>(name: string, inputs: I) =>
  service({ name, extension: 'test/pack', type: 'compute', inputs, params: {}, build });
