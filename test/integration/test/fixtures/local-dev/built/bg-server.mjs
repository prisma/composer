// Hand-written "built output" for bg-service.ts (S4/S5 fixture) -- a
// dependency-free second service that must NOT restart when only web's
// artifact changes. Self-contained (see web-server.mjs's doc comment for
// why this doesn't import the sibling .ts source).
//
// Also carries the secret/env-param proof (S5, acceptance criterion 5):
// GET /status reports whether the secret looks like a locally-minted
// placeholder (`local-placeholder-<hex>`) and echoes the bound greeting —
// dev never reaches this far at all when the env-param is unset (preflight
// hard-errors first), so this endpoint's mere reachability is half the proof.

import { secret, string } from '@prisma/composer';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

const service = compute({
  name: 'bkg',
  deps: {},
  secrets: { apiKey: secret() },
  params: { greeting: string() },
  build: node({ module: import.meta.url, entry: 'bg-server.mjs' }),
});

const { port, greeting } = service.config();
const { apiKey } = service.secrets();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      return Response.json({
        greeting,
        apiKeyIsPlaceholder: apiKey.expose().startsWith('local-placeholder-'),
      });
    }
    return new Response('local-dev fixture: bg', { status: 200 });
  },
});

console.log(`[fixture] bg listening on ${port}`);
