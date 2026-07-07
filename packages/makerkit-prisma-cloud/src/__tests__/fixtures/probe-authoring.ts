// Bundle probe for the import-split guard: uses BOTH authoring entries (core
// and pack) the way a user service module would, with real value usage so
// nothing tree-shakes away.
import { configOf, Load } from '@makerkit/core';
import { compute, postgres } from '@makerkit/prisma-cloud';

const app = compute({ db: postgres({ client: ({ url }) => ({ url }) }) }, ({ db }) => db);

export const graph = Load(app, { id: 'probe' });
export const manifest = configOf(app);
