// Hand-written "built output" for bg-service.ts (S4/S5 fixture) -- a
// dependency-free second service that must NOT restart when only web's
// artifact changes. Self-contained (see web-server.mjs's doc comment for
// why this doesn't import the sibling .ts source).
//
// Also carries the secret/env-param proof (S5, acceptance criterion 5),
// migrated to ADR-0042: GET /status reports whether the secret looks like a
// locally-minted placeholder (`local-placeholder-<hex>`). The env-sourced
// param rides the reserved `port` channel (module.ts binds it to
// LOCALDEV_FIXTURE_GREETING) — dev never reaches this far at all when it is
// unset (preflight hard-errors first), so this endpoint's mere reachability
// is half the proof.

import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const service = compute({
  name: 'bkg',
  deps: {},
  input: type({ apiKey: secretString() }),
  build: node({ module: import.meta.url, entry: 'bg-server.mjs' }),
});

// The reserved port local dev's Deployment provider materializes into this
// process's env (the emulator-assigned port), read back address-free.
const port = service.port();
const { apiKey } = service.input();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      return Response.json({
        apiKeyIsPlaceholder: apiKey.expose().startsWith('local-placeholder-'),
      });
    }
    return new Response('local-dev fixture: bg', { status: 200 });
  },
});

console.log(`[fixture] bg listening on ${port}`);
