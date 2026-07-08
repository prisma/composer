/**
 * Assembles a Next.js `output: "standalone"` build into the bundle dir the
 * pack packages at deploy. Run `next build` first (the `build:compute`
 * script does). Next's standalone tree omits the static assets and
 * `public/`, so this copies them in. The bundle entry is NOT server.js
 * directly: the app's MakerKit wrapper (`src/service.ts` — declarations
 * only, whose node carries its own run()) is bundled to `main.mjs` next to
 * server.js, so the relative import resolves inside the artifact and the
 * MakerKit boot loop runs first (bootstrap.js imports main.mjs, then
 * dynamically imports server.js — see @makerkit/core/deploy's PackageInput).
 *
 * MakerKit ships no build step, but it does own the artifact envelope —
 * bootstrap.js + compute.manifest.json + the deterministic tar are printed
 * by the pack's `package()` at deploy, not here.
 *
 * Requires a hoisted node_modules (see the repo `.npmrc`): pnpm's default
 * isolated layout hides Next's peers (e.g. styled-jsx) under `.pnpm`, and the
 * flattened standalone `next` copy can't resolve them at boot.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'tsdown';

/** Where Next's standalone build places this app, given `outputFileTracingRoot` pins the monorepo root. */
export function nextStandaloneDir(appDir: string): string {
  const resolvedApp = path.resolve(appDir);
  const workspaceRoot = path.resolve(resolvedApp, '../../../..');
  const rel = path.relative(workspaceRoot, resolvedApp);
  return path.join(resolvedApp, '.next', 'standalone', rel);
}

export interface BundleNextResult {
  readonly bundleDir: string;
}

export async function bundleNextComputeArtifact(appDir: string): Promise<BundleNextResult> {
  const resolvedApp = path.resolve(appDir);
  const appOut = nextStandaloneDir(appDir);
  if (!fs.existsSync(path.join(appOut, 'server.js'))) {
    throw new Error(
      `no standalone server.js at ${appOut} — run \`next build\` with output: "standalone" first`,
    );
  }

  // Next hoists the traced node_modules to the STANDALONE ROOT, resolved from
  // the nested server.js by walking up. But the artifact tars only this app
  // subdir (the bundle dir), so those deps (`next`, `react`, …) are left out —
  // the VM then can't resolve `next` from server.js. Copy the hoisted tree in
  // so the bundle dir is self-contained.
  const standaloneRoot = path.join(resolvedApp, '.next', 'standalone');
  const rootModules = path.join(standaloneRoot, 'node_modules');
  if (
    path.resolve(rootModules) !== path.resolve(appOut, 'node_modules') &&
    fs.existsSync(rootModules)
  ) {
    await fs.promises.cp(rootModules, path.join(appOut, 'node_modules'), { recursive: true });
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

  // Bundle the MakerKit wrapper to a temp dir, then place it next to
  // server.js as main.mjs (unambiguously ESM — the standalone tree's
  // package.json is CJS-default). Its run()'s `import("./server.js")`
  // resolves relative to this file inside the artifact.
  const bundleTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storefront-main-'));
  try {
    await build({
      entry: [path.join(resolvedApp, 'src', 'service.ts')],
      outDir: bundleTmp,
      format: 'esm',
      platform: 'node',
      external: ['bun'],
      // Workspace packages must be inlined (this is .ts source, not requireable
      // JS). arktype must be too: service.ts's `rpc(authContract)` dep evaluates
      // the shared auth.contract.ts at import time, which calls arktype's
      // `type()` — this build is separate from Next's own, so it can't rely on
      // Next's standalone node_modules trace to have arktype in place.
      noExternal: [/^@makerkit\//, /^arktype/],
      dts: false,
      sourcemap: false,
      clean: false,
    });
    const built = fs.readdirSync(bundleTmp).find((f) => /^service\.m?js$/.test(f));
    if (!built) throw new Error(`tsdown produced no service.js in ${bundleTmp}`);
    await fs.promises.copyFile(path.join(bundleTmp, built), path.join(appOut, 'main.mjs'));
  } finally {
    await fs.promises.rm(bundleTmp, { recursive: true, force: true });
  }

  // Disable bun's runtime auto-install. Next's server.js references `sharp` /
  // `@next/swc` (optional native deps this app never uses); on Compute, bun
  // tries to fetch their linux binaries at that `require`, filling the tiny
  // disk (ENOSPC -> reboot loop). With auto-install off, the require fails
  // gracefully and Next boots — exactly as it does locally. bun reads bunfig
  // from the process CWD, which is the artifact root at boot.
  await fs.promises.writeFile(path.join(appOut, 'bunfig.toml'), '[install]\nauto = "disable"\n');

  return { bundleDir: appOut };
}

if (import.meta.main) {
  const appDir = process.argv[2];
  if (!appDir) {
    console.error('Usage: bun scripts/bundle-next.ts <appDir>');
    process.exit(1);
  }
  const result = await bundleNextComputeArtifact(appDir);
  console.log(`Bundled ${result.bundleDir}`);
}
