/**
 * The extension's control entry (ADR-0017): `nextjsBuild()` returns the
 * descriptor `prisma-app.config.ts` lists — one build control, node ID
 * "nextjs". Deploy-only (ADR-0005): assembles a Next.js `output:
 * "standalone"` build into the bundle dir packaged at deploy. Run `next
 * build` first. The heavy tsdown import lives only here, never in the
 * authoring entry.
 *
 * Next's standalone tree omits the static assets and `public/`, so this
 * copies them in. The bundle entry is NOT server.js directly: the app's
 * Prisma App wrapper (the service module — declarations only, whose node
 * carries its own run()) is bundled to `main.mjs` next to server.js, so the
 * relative import resolves inside the artifact and the Prisma App boot loop
 * runs first (bootstrap.js imports main.mjs, then dynamically imports
 * server.js — see @prisma/app/deploy's PackageInput).
 *
 * Prisma App ships no build step, but it does own the artifact envelope —
 * bootstrap.js + compute.manifest.json + the deterministic tar are printed
 * by the platform extension's `package()` at deploy, not here.
 *
 * Requires a hoisted node_modules (see the repo `.npmrc`): pnpm's default
 * isolated layout hides Next's peers (e.g. styled-jsx) under `.pnpm`, and the
 * flattened standalone `next` copy can't resolve them at boot.
 *
 * All paths are file-relative (ADR-0004): the build adapter's `appDir`
 * resolves against `dirname(build.module)`, never against a discovered
 * package directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildAdapter } from '@prisma/app';
import type { ExtensionDescriptor } from '@prisma/app/config';
import type { AssembleInput, Bundle } from '@prisma/app/deploy';
import { build } from 'tsdown';
import type { NextjsBuildAdapter } from './index.ts';

export type { AssembleInput, Bundle } from '@prisma/app/deploy';

/** Narrows the shared BuildAdapter to this extension's own descriptor — the value-level mirror of the registry routing on (extension, type). */
function isNextjsBuild(descriptor: BuildAdapter): descriptor is NextjsBuildAdapter {
  return (
    descriptor.type === 'nextjs' && 'appDir' in descriptor && typeof descriptor.appDir === 'string'
  );
}

/** Where Next's standalone build places this app, given `outputFileTracingRoot` pins the monorepo root. */
export function nextStandaloneDir(appDir: string): string {
  const resolvedApp = path.resolve(appDir);
  const workspaceRoot = path.resolve(resolvedApp, '../../../..');
  const rel = path.relative(workspaceRoot, resolvedApp);
  return path.join(resolvedApp, '.next', 'standalone', rel);
}

/** The bootable standalone entry for a nextjs build — the output dir joined with the adapter's `entry`. Single-sourced so `assemble()` (deploy) and the integration-test seam can't drift. */
export function standaloneEntryPath(build: NextjsBuildAdapter): string {
  const resolvedApp = path.resolve(path.dirname(fileURLToPath(build.module)), build.appDir);
  return path.join(nextStandaloneDir(resolvedApp), build.entry);
}

export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (!isNextjsBuild(input.build)) {
    throw new Error(
      `@prisma/app-nextjs/control: expected a "nextjs" build adapter (with appDir), got "${input.build.type}".`,
    );
  }
  const buildDescriptor = input.build;

  const serviceModule = fileURLToPath(buildDescriptor.module);
  const moduleDir = path.dirname(serviceModule);
  const resolvedApp = path.resolve(moduleDir, buildDescriptor.appDir);
  const appOut = nextStandaloneDir(resolvedApp);
  const entryPath = standaloneEntryPath(buildDescriptor);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `no standalone ${buildDescriptor.entry} at ${appOut} — run \`next build\` with output: "standalone" first`,
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

  // Bundle the Prisma App wrapper to a temp dir, then place it next to
  // server.js as main.mjs (unambiguously ESM — the standalone tree's
  // package.json is CJS-default). Its run()'s `import("./server.js")`
  // resolves relative to this file inside the artifact.
  const bundleTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prisma-app-nextjs-main-'));
  try {
    await build({
      entry: [serviceModule],
      outDir: bundleTmp,
      format: 'esm',
      platform: 'node',
      external: ['bun'],
      // Workspace packages must be inlined (this is .ts source, not requireable
      // JS); everything Next needs is already in the standalone tree and is NOT
      // imported by the entry. The caller adds the app's own import-time deps
      // via wrapperNoExternal — this build is separate from Next's, so it can't
      // rely on the standalone node_modules trace to cover them.
      noExternal: [/^@prisma\//, ...(input.wrapperNoExternal ?? [])],
      dts: false,
      sourcemap: false,
      clean: false,
      // Do NOT auto-load this package's tsdown.config.ts: its `exports`
      // management would rewrite this package's package.json to the throwaway
      // bundle dir, corrupting resolution of @prisma/app-nextjs afterward.
      config: false,
    });
    const built = fs.readdirSync(bundleTmp).find((f) => /^service\.m?js$/.test(f));
    if (built === undefined) {
      throw new Error(`tsdown produced no service.js in ${bundleTmp}`);
    }
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

  return { dir: appOut, entry: buildDescriptor.entry };
}

/** The nextjs build extension descriptor — `prisma-app.config.ts` lists it under `extensions`. */
export const nextjsBuild = (): ExtensionDescriptor => ({
  id: '@prisma/app-nextjs',
  nodes: {
    nextjs: { kind: 'build', assemble },
  },
});
