// Hand-written "built output" for bg-service.ts (S4 fixture) -- a
// dependency-free second service that must NOT restart when only web's
// artifact changes. Self-contained (see web-server.mjs's doc comment for
// why this doesn't import the sibling .ts source).

import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

const service = compute({
  name: 'bkg',
  deps: {},
  build: node({ module: import.meta.url, entry: 'bg-server.mjs' }),
});

const { port } = service.config();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: () => new Response('local-dev fixture: bg', { status: 200 }),
});

console.log(`[fixture] bg listening on ${port}`);
