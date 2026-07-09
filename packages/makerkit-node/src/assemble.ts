/**
 * Deploy-only (ADR-0005): the user's own build produces the app's runnable;
 * this assembles MakerKit's deploy artifact from it. Validates the built
 * entry exists, bundles the service module (the MakerKit wrapper) to its own
 * output, then copies the app's entry in beside it.
 *
 * Two SEPARATE builds, not one multi-entry build: a single build would
 * dedupe the shared service module into a chunk both entries import — one
 * module instance. run() (the wrapper) and load() (the app entry) must be
 * independent instances that hand off through process.env, so the wrapper
 * gets its own self-contained build and the app's already-built entry is
 * copied in untouched. @makerkit/* is inlined (node_modules isn't shipped);
 * `bun` is a Compute runtime built-in.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BuildAdapter } from '@makerkit/core';
import { build } from 'tsdown';

export interface AssembleInput {
  /** The nearest package.json dir above the service's authoring module. */
  readonly serviceDir: string;
  /** The service module (e.g. src/service.ts) — what the wrapper bundles. */
  readonly serviceModule: string;
  readonly build: BuildAdapter;
  /**
   * Extra patterns to inline into the wrapper besides `@makerkit/*` — the
   * service module's own imports that are neither shipped in the bundle dir
   * nor runtime built-ins (e.g. the app's workspace packages).
   */
  readonly wrapperNoExternal?: readonly RegExp[];
}

export interface AssembledBundle {
  readonly dir: string;
  readonly entry: string;
}

export async function assemble(input: AssembleInput): Promise<AssembledBundle> {
  if (input.build.kind !== 'node') {
    throw new Error(
      `@makerkit/node/assemble: expected a "node" build adapter, got "${input.build.kind}".`,
    );
  }

  const entryPath = path.resolve(input.serviceDir, input.build.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `no built entry at ${entryPath} — run this app's own build first (the build adapter's ` +
        `entry, "${input.build.entry}", is resolved against the service dir).`,
    );
  }
  // "main" is the wrapper's name inside the bundle; an app entry with the same
  // basename would silently overwrite it and run() would never execute.
  if (/^main\.m?js$/.test(path.basename(entryPath))) {
    throw new Error(
      `the build adapter's entry ("${input.build.entry}") may not be named main.js/main.mjs — ` +
        'that name is reserved for the MakerKit wrapper in the assembled bundle.',
    );
  }

  const bundleDir = path.join(input.serviceDir, 'dist', 'bundle');
  await fs.promises.rm(bundleDir, { recursive: true, force: true });
  await fs.promises.mkdir(bundleDir, { recursive: true });

  await build({
    entry: [input.serviceModule],
    outDir: bundleDir,
    format: 'esm',
    platform: 'node',
    external: ['bun'],
    noExternal: [/^@makerkit\//, ...(input.wrapperNoExternal ?? [])],
    dts: false,
    sourcemap: false,
    clean: false,
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
