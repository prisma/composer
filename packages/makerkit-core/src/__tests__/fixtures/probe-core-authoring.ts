// Bundle probe for the import-split guard: uses core's authoring entry the way
// a user service module would, with real value usage so nothing tree-shakes away.
import {
  configOf,
  connectionEnd,
  hex,
  hydrate,
  Load,
  resource,
  resourceEnd,
  service,
} from '../../index.ts';

const db = resourceEnd({
  name: 'db',
  type: 'probe/db',
  connection: {
    params: { url: { type: 'string', secret: true } },
    hydrate: (v) => ({ url: v.url }),
  },
});

const app = service({
  name: 'test-service',
  pack: 'test/pack',
  type: 'probe/app',
  inputs: { db },
  params: { port: { type: 'number', default: 3000 } },
  build: {
    kind: 'node',
    pack: '@makerkit/node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});

const peer = connectionEnd({
  type: 'probe/http',
  connection: { params: { url: { type: 'string' } }, hydrate: (v) => ({ url: v.url }) },
});

const caller = service({
  name: 'test-service',
  pack: 'test/pack',
  type: 'probe/app',
  inputs: { peer },
  params: {},
  build: {
    kind: 'node',
    pack: '@makerkit/node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});

const dbNode = resource({ name: 'db', pack: 'test/pack', type: 'probe/db' });

export const graph = Load(
  hex('probe-hex', (h) => {
    const dbRef = h.provision('db', dbNode);
    const ref = h.provision('app', app, { db: dbRef });
    h.provision('caller', caller, { peer: ref });
  }),
  { id: 'probe' },
);

export const declarations = configOf(app);
export const hydrated = hydrate(app, { service: { port: 3000 }, inputs: { db: { url: 'x' } } });
