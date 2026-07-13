/**
 * The extension's control entry (ADR-0017): `nextjsBuild()` returns the
 * descriptor `prisma-compose.config.ts` lists — one build control, node ID
 * "nextjs". Deploy-only (ADR-0005): the user's own build produces a finished,
 * flat Next.js `output: "standalone"` tree — server.js, the traced
 * node_modules, and the client assets (`.next/static`, `public/`) copied in —
 * and `assemble` only wraps it. The heavy tsdown import lives only here.
 *
 * We don't complete or repair the tree (ADR-0005): no static/public copy, no
 * node_modules hoisting, no path arithmetic to locate the standalone output.
 * The user hands us the standalone root via `standalone` and the bootable
 * server path via `entry`; we copy that tree wholesale into the artifact's
 * `bundle/` and add our wrapper beside it. A symlink in the tree is the
 * packager's hard error, not ours to dereference.
 *
 * Artifact layout: `<workDir>/main.mjs` (our wrapper) + `<workDir>/bundle/`
 * (the user's standalone tree); the packager adds `bootstrap.js` + the
 * manifest. bootstrap imports main.mjs, whose run() dynamically imports
 * `./bundle/<entry>`; server.js resolves its deps from `bundle/node_modules`.
 *
 * All paths are file-relative (ADR-0004): `standalone` resolves against
 * `dirname(build.module)`, never against a discovered package directory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildAdapter } from '@internal/core';
import type { ExtensionDescriptor } from '@internal/core/config';
import type { AssembleInput, Bundle } from '@internal/core/deploy';
import { build } from 'tsdown';
import type { NextjsBuildAdapter } from './index.ts';

export type { AssembleInput, Bundle } from '@internal/core/deploy';

/** Narrows the shared BuildAdapter to this extension's own descriptor — the value-level mirror of the registry routing on (extension, type). */
function isNextjsBuild(descriptor: BuildAdapter): descriptor is NextjsBuildAdapter {
  return (
    descriptor.type === 'nextjs' &&
    'standalone' in descriptor &&
    typeof descriptor.standalone === 'string'
  );
}

/** The user's finished standalone root — `standalone` resolved against the authoring module's dir (ADR-0004); absolute passes through. */
function standaloneRoot(build: NextjsBuildAdapter): string {
  return path.resolve(path.dirname(fileURLToPath(build.module)), build.standalone);
}

/** The bootable standalone server's absolute path — the standalone root joined with the user-nominated `entry`. Single-sourced so `assemble()` (deploy) and the integration-test seam can't drift. */
export function standaloneEntryPath(build: NextjsBuildAdapter): string {
  return path.join(standaloneRoot(build), build.entry);
}

export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (!isNextjsBuild(input.build)) {
    throw new Error(
      `@prisma/compose/nextjs/control: expected a "nextjs" build adapter (with standalone), got "${input.build.type}".`,
    );
  }
  const buildDescriptor = input.build;

  const root = standaloneRoot(buildDescriptor);
  const entryPath = standaloneEntryPath(buildDescriptor);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `no standalone ${buildDescriptor.entry} at ${root} — run \`next build\` with output: ` +
        '"standalone" and flatten it (copy .next/static + public in, materialize any symlinks) ' +
        'so the tree is complete and flat.',
    );
  }
  // "main" is the wrapper's name at the working-dir root; an entry with that
  // basename would collide with it.
  if (/^main\.m?js$/.test(path.basename(buildDescriptor.entry))) {
    throw new Error(
      `the build adapter's entry ("${buildDescriptor.entry}") may not be named main.js/main.mjs — ` +
        'that name is reserved for the Prisma App wrapper at the artifact root.',
    );
  }

  // Deploy-owned, address-keyed working dir (ADR-0005) — never inside the
  // user's build output.
  const workDir = path.join(input.cwd, '.prisma-compose', 'artifacts', input.address);
  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(workDir, { recursive: true });

  // The user's finished flat standalone tree, copied in wholesale. It must
  // already be complete (static/public in, node_modules present) and flat (no
  // symlinks — the packager rejects them); producing that is the user's build's
  // job (ADR-0005), not ours.
  await fs.promises.cp(root, path.join(workDir, 'bundle'), { recursive: true });

  // Our wrapper, bundled to main.mjs at the working-dir root (unambiguously
  // ESM). run()'s `import("./bundle/<entry>")` resolves from here.
  const serviceModule = fileURLToPath(buildDescriptor.module);
  await build({
    entry: { main: serviceModule },
    outDir: workDir,
    format: 'esm',
    platform: 'node',
    external: ['bun'],
    // Workspace packages must be inlined (this is .ts source, not requireable
    // JS); everything Next needs is already in the standalone tree and is NOT
    // imported by the entry. The caller adds the app's own import-time deps via
    // wrapperNoExternal.
    noExternal: [/^@prisma\//, ...(input.wrapperNoExternal ?? [])],
    dts: false,
    sourcemap: false,
    clean: false,
    // Do NOT auto-load this package's tsdown.config.ts: its `exports`
    // management would rewrite this package's package.json to the throwaway
    // bundle dir, corrupting resolution of @prisma/compose/nextjs afterward.
    config: false,
  });
  const wrapperPath = path.join(workDir, 'main.mjs');
  if (!fs.existsSync(wrapperPath)) {
    throw new Error(`tsdown produced no main.mjs in ${workDir}`);
  }

  // Disable bun's runtime auto-install. Next's server.js references `sharp` /
  // `@next/swc` (optional native deps this app never uses); on Compute, bun
  // tries to fetch their linux binaries at that `require`, filling the tiny
  // disk (ENOSPC -> reboot loop). With auto-install off, the require fails
  // gracefully and Next boots. bun reads bunfig from the process CWD, which is
  // the artifact root (this working dir) at boot.
  await fs.promises.writeFile(path.join(workDir, 'bunfig.toml'), '[install]\nauto = "disable"\n');

  return { dir: workDir, entry: path.posix.join('bundle', buildDescriptor.entry) };
}

/** The nextjs build extension descriptor — `prisma-compose.config.ts` lists it under `extensions`. */
export const nextjsBuild = (): ExtensionDescriptor => ({
  id: '@prisma/compose/nextjs',
  nodes: {
    nextjs: { kind: 'build', assemble },
  },
});
