// Hand-written "built output" for bg-service.ts (S4/S5 fixture) -- a
// dependency-free second service that must NOT restart when only web's
// artifact changes. Self-contained (see web-server.mjs's doc comment for
// why this doesn't import the sibling .ts source).
//
// GET /status reports a hash of the secret it received (never the value) and
// whether the optional secret arrived, so a test can see which value reached
// this process.

import { createHash } from 'node:crypto';
import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const service = compute({
  name: 'bkg',
  deps: {},
  input: type({ apiKey: secretString(), 'webhookSecret?': secretString() }),
  build: node({ module: import.meta.url, entry: 'bg-server.mjs' }),
});

// The reserved port local dev's Deployment provider materializes into this
// process's env (the emulator-assigned port), read back address-free.
const port = service.port();
const { apiKey, webhookSecret } = service.input();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      return Response.json({
        apiKeySha256: createHash('sha256').update(apiKey.expose()).digest('hex'),
        hasWebhookSecret: webhookSecret !== undefined,
      });
    }
    return new Response('local-dev fixture: bg', { status: 200 });
  },
});

console.log(`[fixture] bg listening on ${port}`);
