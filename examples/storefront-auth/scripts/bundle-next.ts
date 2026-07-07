/**
 * Packages a Next.js `output: "standalone"` build into a Prisma Compute artifact.
 *
 * Run `next build` first (the `build:compute` script does). Next's standalone
 * tree omits the static assets and `public/`, so this copies them in. The
 * manifest entrypoint is NOT server.js directly: the app's MakerKit runtime
 * entry (`src/main.ts` — runHost over the service, whose handler boots
 * `./server.js`) is bundled to `main.mjs` next to server.js, so the relative
 * import resolves inside the tar and the MakerKit host runs first.
 *
 * Requires a hoisted node_modules (see the repo `.npmrc`): pnpm's default
 * isolated layout hides Next's peers (e.g. styled-jsx) under `.pnpm`, and the
 * flattened standalone `next` copy can't resolve them at boot.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { $ } from 'bun';
import { build } from 'tsdown';

const MANIFEST_VERSION = '1';

export interface BundleNextResult {
  outFile: string;
  sha256: string;
  entrypoint: string;
}

export async function bundleNextComputeArtifact(
  appDir: string,
  outFile: string,
): Promise<BundleNextResult> {
  const resolvedApp = path.resolve(appDir);
  const resolvedOut = path.resolve(outFile);

  // next.config.ts pins outputFileTracingRoot to the monorepo root, so the
  // standalone nests the app (and server.js) under its path below that root.
  const workspaceRoot = path.resolve(resolvedApp, '../../../..');
  const rel = path.relative(workspaceRoot, resolvedApp);

  const standalone = path.join(resolvedApp, '.next', 'standalone');
  const appOut = path.join(standalone, rel);
  if (!fs.existsSync(path.join(appOut, 'server.js'))) {
    throw new Error(
      `no standalone server.js at ${appOut} — run \`next build\` with output: "standalone" first`,
    );
  }

  // The standalone build ships server.js + traced node_modules but not the
  // client assets; copy them where server.js serves them from.
  await fs.promises.cp(
    path.join(resolvedApp, '.next', 'static'),
    path.join(appOut, '.next', 'static'),
    { recursive: true },
  );
  const publicDir = path.join(resolvedApp, 'public');
  if (fs.existsSync(publicDir)) {
    await fs.promises.cp(publicDir, path.join(appOut, 'public'), { recursive: true });
  }

  // Bundle the MakerKit runtime entry to a temp dir, then place it next to
  // server.js as main.mjs (unambiguously ESM — the standalone tree's
  // package.json is CJS-default). Its handler's `import("./server.js")`
  // resolves relative to this file inside the tar.
  const bundleTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storefront-main-'));
  try {
    await build({
      entry: [path.join(resolvedApp, 'src', 'main.ts')],
      outDir: bundleTmp,
      format: 'esm',
      platform: 'node',
      external: ['bun'],
      // Workspace packages must be inlined; everything Next needs is already
      // in the standalone tree and is NOT imported by the entry.
      noExternal: [/^@makerkit\//],
      dts: false,
      sourcemap: false,
      clean: false,
    });
    const built = fs.readdirSync(bundleTmp).find((f) => /^main\.m?js$/.test(f));
    if (!built) throw new Error(`tsdown produced no main.js in ${bundleTmp}`);
    await fs.promises.copyFile(path.join(bundleTmp, built), path.join(appOut, 'main.mjs'));
  } finally {
    await fs.promises.rm(bundleTmp, { recursive: true, force: true });
  }

  const entrypoint = path.join(rel, 'main.mjs');
  await fs.promises.writeFile(
    path.join(standalone, 'compute.manifest.json'),
    JSON.stringify({ manifestVersion: MANIFEST_VERSION, entrypoint }, null, 2),
  );

  await fs.promises.mkdir(path.dirname(resolvedOut), { recursive: true });
  await $`tar -czf ${resolvedOut} -C ${standalone} .`;

  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(resolvedOut).arrayBuffer());
  return { outFile: resolvedOut, sha256: hasher.digest('hex'), entrypoint };
}

if (import.meta.main) {
  const appDir = process.argv[2];
  const outFile = process.argv[3];
  if (!appDir || !outFile) {
    console.error('Usage: bun scripts/bundle-next.ts <appDir> <outFile>');
    process.exit(1);
  }
  const result = await bundleNextComputeArtifact(appDir, outFile);
  console.log(`Built ${result.outFile}`);
  console.log(`entrypoint: ${result.entrypoint}`);
  console.log(`sha256: ${result.sha256}`);
}
