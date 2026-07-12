import type { Contract } from '@internal/core';
import { resource } from '@internal/core';

const fixtureContract: Contract<'fixture/resource', Record<string, never>> = Object.freeze({
  kind: 'fixture/resource',
  __cmp: {},
  satisfies: (required: Contract<'fixture/resource', unknown>) =>
    required.kind === 'fixture/resource',
});

export default resource({
  name: 'fixture-resource',
  extension: 'test/pack',
  provides: fixtureContract,
});
