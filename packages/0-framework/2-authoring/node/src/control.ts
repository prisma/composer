/**
 * The extension's control entry (ADR-0017): `nodeBuild()` returns the build
 * descriptor `prisma-composer.config.ts` lists. Deploy-only (ADR-0005): the user
 * builds their own runnable; `assemble` copies that built entry under `bundle/`
 * and adds the framework's boot wrapper — it never bundles or transforms the
 * app's code.
 *
 * The wrapper is a SEPARATE esbuild build of the service module (declarations
 * only, whose node carries run()/load()), emitted as `main.mjs` at the
 * working-dir root — a dictated name (object entry `{ main }`), not a
 * discovered one. run() and the app entry must be independent module instances
 * that hand off through process.env, so the wrapper is its own self-contained
 * build; `@prisma/*` is inlined, `bun` is a Compute built-in.
 *
 * Artifact layout: `<cwd>/.prisma-composer/artifacts/<address>/` (deploy-owned,
 * ADR-0005) holds `main.mjs` at the root and the app's entry under `bundle/`.
 * `entry` is file-relative to `dirname(build.module)` (ADR-0004).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionDescriptor } from '@internal/core/config';
import type { AssembleInput, Bundle } from '@internal/core/deploy';
import { build } from 'esbuild';

export type { AssembleInput, Bundle } from '@internal/core/deploy';

export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (input.build.type !== 'node') {
    throw new Error(
      `@prisma/composer/node/control: expected a "node" build adapter, got "${input.build.type}".`,
    );
  }

  const serviceModule = fileURLToPath(input.build.module);
  const moduleDir = path.dirname(serviceModule);
  const entryPath = path.resolve(moduleDir, input.build.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `no built entry at ${entryPath} — run your build first (the build adapter's ` +
        `entry, "${input.build.entry}", resolves against dirname(module)).`,
    );
  }

  const workDir = path.join(input.cwd, '.prisma-composer', 'artifacts', input.address);
  // The entry must sit outside the working dir cleared on every assemble, or
  // the rm would delete it before the copy.
  if (entryPath === workDir || entryPath.startsWith(workDir + path.sep)) {
    throw new Error(
      `the build adapter's entry ("${entryPath}") resolves inside the deploy working dir ` +
        `("${workDir}"), which is cleared on every assemble — point entry at your build output elsewhere.`,
    );
  }
  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(workDir, { recursive: true });

  await build({
    entryPoints: { main: serviceModule },
    outdir: workDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['bun', 'bun:*'],
    outExtension: { '.js': '.mjs' },
  });
  if (!fs.existsSync(path.join(workDir, 'main.mjs'))) {
    throw new Error(`esbuild produced no main.mjs in ${workDir}`);
  }

  const entryFile = path.basename(entryPath);
  const bundleDir = path.join(workDir, 'bundle');
  await fs.promises.mkdir(bundleDir, { recursive: true });
  await fs.promises.copyFile(entryPath, path.join(bundleDir, entryFile));

  return { dir: workDir, entry: path.posix.join('bundle', entryFile) };
}

/** The node build extension descriptor — `prisma-composer.config.ts` lists it under `extensions`. */
export const nodeBuild = (): ExtensionDescriptor => ({
  id: '@prisma/composer/node',
  nodes: {
    node: { kind: 'build', assemble },
  },
});
