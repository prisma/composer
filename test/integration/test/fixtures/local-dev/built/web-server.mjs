// Hand-written "built output" for web-service.ts (S4 fixture). A real build
// would bundle web-service.ts's declaration directly into this file (as
// examples/env-param's server.ts does via a real `bun build`); this fixture
// has no bundler, so the SAME compute() shape is declared again here instead
// of importing the sibling .ts source — a relative import to a file outside
// this artifact's own copied bundle would break once the artifact is
// extracted somewhere else (confirmed the hard way: it does). VERSION is
// what the "changed artifact restarts exactly one service" proof edits
// between converges.

import node from '@prisma/composer/node';
import { bucket, compute, postgres } from '@prisma/composer-prisma-cloud';

const service = compute({
  name: 'web',
  deps: { db: postgres(), store: bucket() },
  build: node({ module: import.meta.url, entry: 'web-server.mjs' }),
});

const VERSION = 'v1';

const { port } = service.config();
const { db, store } = service.load();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        version: VERSION,
        db: typeof db.url === 'string' && db.url.length > 0,
        store: typeof store.url === 'string' && store.url.length > 0,
        // The port-override row local dev's Deployment provider materializes
        // into this process's own env (never persisted to env.json — see
        // local-dev spec § 4) — exposed here so a test can assert on it
        // directly, through the documented HTTP contract, rather than
        // inferring it indirectly from a successful bind.
        portEnv: process.env['COMPOSER_WEB_PORT'] ?? null,
      });
    }
    return new Response('local-dev fixture: web', { status: 200 });
  },
});

console.log(`[fixture] web listening on ${port} (${VERSION})`);
