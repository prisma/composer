// Thin caller of @makerkit/nextjs/assemble (ADR-0005): `next build` above
// already produced the standalone tree; this locates it, applies the
// standalone fixups, and bundles the MakerKit wrapper. Run as
// `bun run ../../scripts/assemble-storefront.ts .` from the storefront app
// dir (see hexes/storefront/package.json's build:compute).
import * as path from 'node:path';
import { assemble } from '@makerkit/nextjs/assemble';

const appDir = process.argv[2];
if (!appDir) {
  console.error('Usage: bun scripts/assemble-storefront.ts <appDir>');
  process.exit(1);
}

const serviceDir = path.resolve(process.cwd(), appDir);

const result = await assemble({
  serviceDir,
  serviceModule: path.join(serviceDir, 'src', 'service.ts'),
  build: { kind: 'nextjs', entry: 'server.js' },
  // The wrapper build is separate from Next's, so it can't rely on the
  // standalone node_modules trace: this app's sibling hex packages
  // (service.ts imports @storefront-auth/auth/contract) and arktype (the
  // contract evaluates type() at import time) must be inlined too.
  wrapperNoExternal: [/^@storefront-auth\//, /^arktype/],
});

console.log(`Assembled ${result.dir}/${result.entry}`);
