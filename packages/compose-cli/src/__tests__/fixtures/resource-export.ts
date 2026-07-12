import type { Contract } from '@prisma/compose';
import { resource } from '@prisma/compose';

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
