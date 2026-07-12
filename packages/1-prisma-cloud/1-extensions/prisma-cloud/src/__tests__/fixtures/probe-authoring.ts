// Bundle probe for the import-split guard: uses BOTH authoring entries (core
// and extension) the way a user service module would, with real value usage so
// nothing tree-shakes away.
import { configOf, Load, module } from '@internal/core';
import { compute, postgres } from '@internal/prisma-cloud';

const app = compute({
  name: 'test-service',
  deps: {
    db: postgres(),
  },
  build: {
    extension: '@prisma/compose/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
});

export const graph = Load(
  module('probe-module', {}, ({ provision }) => {
    const db = provision(postgres({ name: 'db' }), { id: 'db' });
    provision(app, { id: 'app', deps: { db } });
    return {};
  }),
  { id: 'probe' },
);

export const manifest = configOf(app);
