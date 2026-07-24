/// <reference types="bun" />
/**
 * Integration proof (testing.md § Integration): the real request path — the
 * actual Next.js standalone entry, the real RPC client, real HTTP — driven
 * by `bootstrapService` against a fake auth listening on a loopback port. No
 * cloud, no deploy; `server.ts`/the Next build output are untouched. Run via
 * `bun test` (not vitest — the unit test's runner): it needs `Bun.serve` for
 * the loopback fake, and the H3 teardown decision (no `close()`) rests on
 * bun-test's per-file process isolation.
 *
 * storefront's build is `nextjs({ appDir })`: the deploy assembler locates the
 * built `server.js` inside the standalone tree, so this test boots it via the
 * same seam (`standaloneServerPath`) rather than re-deriving the path. The
 * deploy chain is bootstrap.js -> main.mjs -> server.js; here
 * `bootstrapService`'s `stash` stands in for the wrapper's env write. Requires
 * `next build` to have produced `.next/standalone` (turbo's `test` task depends
 * on `build`, so `pnpm -w test` always has it).
 */
import { describe, expect, it } from 'bun:test';
import { pathToFileURL } from 'node:url';
import type { BuildAdapter } from '@prisma/composer';
import type { NextjsBuildAdapter } from '@prisma/composer/nextjs';
import { standaloneServerPath } from '@prisma/composer/nextjs/control';
import { bootstrapService } from '@prisma/composer-prisma-cloud/testing';
import fakeAuthHandler from '@storefront-auth/auth/fake';
import storefrontService from '../src/service.ts';

const PORT = 4310;

function isNextjsBuild(build: BuildAdapter): build is NextjsBuildAdapter {
  return build.type === 'nextjs' && 'appDir' in build && typeof build.appDir === 'string';
}

/** Boots the built standalone Next entry — its own `server.js`, unmodified — via the same seam `assemble()` uses to locate it. The deploy chain is bootstrap.js -> main.mjs -> server.js; here `bootstrapService`'s env writes (Config stash + PORT) stand in for the wrapper's, and Next's standalone server binds `process.env.PORT` directly. */
function bootStandaloneNext(build: NextjsBuildAdapter): () => Promise<void> {
  const entryPath = standaloneServerPath(build);
  return async () => {
    await import(pathToFileURL(entryPath).href);
  };
}

describe('storefront -> auth round trip, driven over real HTTP (bootstrapService)', () => {
  it('renders auth.verify() -> { ok: true } served by the fake auth on a loopback port', async () => {
    if (!isNextjsBuild(storefrontService.build)) {
      throw new Error('expected the storefront service to use the nextjs build adapter');
    }

    const fake = Bun.serve({ port: 0, fetch: fakeAuthHandler });

    const app = await bootstrapService(
      storefrontService,
      { service: { port: PORT }, inputs: { auth: { url: fake.url.href } } },
      bootStandaloneNext(storefrontService.build),
    );

    const res = await app.fetch(new Request(app.url));
    // React separates the static text from the {String(ok)} expression with an
    // empty `<!-- -->` comment; assert around it rather than stripping HTML.
    const html = await res.text();

    expect(html).toContain('Auth /verify says: <!-- -->true');
    expect(html).toContain('Secret /check says: <!-- -->true');
  });
});
