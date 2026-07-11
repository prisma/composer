/**
 * Deploy-only (ADR-0005): the user's own build produces the app's runnable;
 * this assembles Prisma App's deploy artifact from it. Validates the built
 * entry exists, bundles the service module (the Prisma App wrapper) to its own
 * output, then copies the app's entry in beside it.
 *
 * Two SEPARATE builds, not one multi-entry build: a single build would
 * dedupe the shared service module into a chunk both entries import — one
 * module instance. run() (the wrapper) and load() (the app entry) must be
 * independent instances that hand off through process.env, so the wrapper
 * gets its own self-contained build and the app's already-built entry is
 * copied in untouched. @prisma/* is inlined (node_modules isn't shipped);
 * `bun` is a Compute runtime built-in.
 *
 * All paths are file-relative (ADR-0004): `build.entry` resolves against
 * `dirname(build.module)`, never against a discovered package directory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssembleInput, Bundle } from '@prisma/app/deploy';
import { build } from 'tsdown';

export type { AssembleInput, Bundle } from '@prisma/app/deploy';

export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (input.build.kind !== 'node') {
    throw new Error(
      `@prisma/app-node/assemble: expected a "node" build adapter, got "${input.build.kind}".`,
    );
  }

  const serviceModule = fileURLToPath(input.build.module);
  const moduleDir = path.dirname(serviceModule);
  const entryPath = path.resolve(moduleDir, input.build.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `no built entry at ${entryPath} — run this app's own build first (the build adapter's ` +
        `entry, "${input.build.entry}", is resolved against dirname(module)).`,
    );
  }
  // "main" is the wrapper's name inside the bundle; an app entry with the same
  // basename would silently overwrite it and run() would never execute.
  if (/^main\.m?js$/.test(path.basename(entryPath))) {
    throw new Error(
      `the build adapter's entry ("${input.build.entry}") may not be named main.js/main.mjs — ` +
        'that name is reserved for the Prisma App wrapper in the assembled bundle.',
    );
  }

  // Beside the built entry — file-relative to the resolved entry, not a
  // discovered package dir (ADR-0004).
  const bundleDir = path.join(path.dirname(entryPath), 'bundle');
  // The entry must survive the `rm` below to reach the `copyFile` after it —
  // if it resolved inside the reserved output dir, the rm would delete it
  // first and the copy would fail with a bare ENOENT instead of a named error.
  if (entryPath === bundleDir || entryPath.startsWith(bundleDir + path.sep)) {
    throw new Error(
      `the build adapter's entry ("${entryPath}") resolves inside its own output dir ` +
        `("${bundleDir}") — Prisma App reserves that directory for the assembled bundle and ` +
        'clears it before every assemble; point entry at your build output elsewhere.',
    );
  }
  await fs.promises.rm(bundleDir, { recursive: true, force: true });
  await fs.promises.mkdir(bundleDir, { recursive: true });

  await build({
    entry: [serviceModule],
    outDir: bundleDir,
    format: 'esm',
    platform: 'node',
    external: ['bun'],
    noExternal: [/^@prisma\//, ...(input.wrapperNoExternal ?? [])],
    dts: false,
    sourcemap: false,
    clean: false,
    // Self-contained runtime bundle: do NOT auto-load a discovered
    // `tsdown.config.ts`. This package's build config enables tsdown's
    // `exports` management, which would rewrite THIS package's package.json
    // `exports` to point at the throwaway bundle dir — corrupting resolution
    // of `@prisma/app-node` for everything that imports it afterward.
    config: false,
  });

  const built = fs.readdirSync(bundleDir).find((f) => /^service\.m?js$/.test(f));
  if (built === undefined) {
    throw new Error(`tsdown produced no service.js in ${bundleDir}`);
  }
  const wrapperFile = built.endsWith('.mjs') ? 'main.mjs' : 'main.js';
  await fs.promises.rename(path.join(bundleDir, built), path.join(bundleDir, wrapperFile));

  const entryFile = path.basename(entryPath);
  await fs.promises.copyFile(entryPath, path.join(bundleDir, entryFile));

  return { dir: bundleDir, entry: entryFile };
}
