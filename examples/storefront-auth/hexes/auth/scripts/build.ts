// App-owned build: bundle the runtime entry, wrap it in Compute's artifact
// envelope (compute.manifest.json + tar.gz). MakerKit ships no build step.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import { build } from 'tsdown';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const bundleDir = path.join(rootDir, 'dist', 'bundle');
const outFile = path.join(rootDir, 'dist', 'auth.tar.gz');

await build({
  entry: [path.join(rootDir, 'src', 'main.ts')],
  outDir: bundleDir,
  format: 'esm',
  platform: 'node',
  // "bun" is a runtime built-in on Compute — unresolvable at bundle time.
  external: ['bun'],
  // Workspace packages and hono must be inlined: node_modules is not shipped.
  noExternal: [/^@makerkit\//, /^hono/],
  dts: false,
  sourcemap: false,
  clean: true,
});

const entrypoint = fs.readdirSync(bundleDir).find((f) => /^main\.m?js$/.test(f));
if (!entrypoint) throw new Error(`tsdown produced no main.js in ${bundleDir}`);

fs.writeFileSync(
  path.join(bundleDir, 'compute.manifest.json'),
  JSON.stringify({ manifestVersion: '1', entrypoint }, null, 2),
);

await $`tar -czf ${outFile} -C ${bundleDir} .`;

const hasher = new Bun.CryptoHasher('sha256');
hasher.update(await Bun.file(outFile).arrayBuffer());
console.log(`Built ${outFile}`);
console.log(`sha256: ${hasher.digest('hex')}`);
