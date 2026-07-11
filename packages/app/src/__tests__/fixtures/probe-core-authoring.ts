import { number, string } from '../../config.ts';
// Bundle probe for the import-split guard: uses core's authoring entry the way
// a user service module would, with real value usage so nothing tree-shakes away.
import type { Contract } from '../../index.ts';
import { configOf, dependency, hydrate, Load, resource, service, system } from '../../index.ts';

// A pack-shaped provider contract: kind-satisfies, like postgresContract.
const dbContract: Contract<'probe/db', { url: string }> = Object.freeze({
  kind: 'probe/db',
  __cmp: { url: '' },
  satisfies: (required: Contract<'probe/db', unknown>) => required.kind === 'probe/db',
});

const db = dependency({
  name: 'db',
  type: 'probe/db',
  connection: {
    params: { url: string({ secret: true }) },
    hydrate: (v) => ({ url: v.url }),
  },
  required: dbContract,
});

const app = service({
  name: 'test-service',
  extension: 'test/pack',
  type: 'probe/app',
  inputs: { db },
  params: { port: number({ default: 3000 }) },
  build: {
    extension: '@prisma/app-node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});

const peer = dependency({
  type: 'probe/http',
  connection: { params: { url: string() }, hydrate: (v) => ({ url: v.url }) },
});

const caller = service({
  name: 'test-service',
  extension: 'test/pack',
  type: 'probe/app',
  inputs: { peer },
  params: {},
  build: {
    extension: '@prisma/app-node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});

const dbNode = resource({ name: 'db', extension: 'test/pack', provides: dbContract });

export const graph = Load(
  system('probe-system', {}, ({ provision }) => {
    const dbRef = provision('db', dbNode);
    const ref = provision('app', app, { db: dbRef });
    provision('caller', caller, { peer: ref });
    return {};
  }),
  { id: 'probe' },
);

export const declarations = configOf(app);
export const hydrated = hydrate(app, { service: { port: 3000 }, inputs: { db: { url: 'x' } } });
