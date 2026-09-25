import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import alchemyPackage from '@alchemy.run/frontend-frameworks/package.json' with { type: 'json' };
import { isWithin } from '@internal/bundle-paths';
import type { BuildAdapter } from '@internal/core';
import type { ExtensionDescriptor } from '@internal/core/config';
import type { AssembleInput, Bundle } from '@internal/core/deploy';
import type { FrameworkBuildAdapter } from '../framework.ts';
import { assembleFrameworkArtifact } from './artifact.ts';
import { buildFramework } from './build.ts';

function isFramework(value: unknown): value is FrameworkBuildAdapter['framework'] {
  return typeof value === 'string' && `./${value}/node` in alchemyPackage.exports;
}

function isFrameworkBuild(build: BuildAdapter): build is FrameworkBuildAdapter {
  return (
    build.extension === '@prisma/composer/frameworks' &&
    build.type === 'framework' &&
    'framework' in build &&
    isFramework(build.framework) &&
    'root' in build &&
    typeof build.root === 'string'
  );
}

/** Strictly inside `root`: the shared containment predicate, minus `root` itself. */
function inside(root: string, candidate: string): boolean {
  return path.relative(root, candidate) !== '' && isWithin(root, candidate);
}

function generatedState(root: string): string[] {
  return [
    '.alchemy',
    '.astro',
    '.git',
    '.nuxt',
    '.prisma-composer',
    '.svelte-kit',
    '.tanstack',
    '.turbo',
    '.vite',
    'next-env.d.ts',
    'node_modules',
    'serve-node.mjs',
  ].map((name) => path.join(root, name));
}

/** Alchemy owns framework staging; Composer adds its boot wrapper and lifecycle. */
export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (!isFrameworkBuild(input.build)) {
    throw new Error('Expected a @prisma/composer/frameworks build descriptor.');
  }
  const descriptor = input.build;
  const moduleDir = path.dirname(fileURLToPath(descriptor.module));
  const root = await fs.promises.realpath(path.resolve(moduleDir, descriptor.root));
  const output = await buildFramework(descriptor.framework, root);

  const dist = output.distDirectory === undefined ? undefined : path.resolve(output.distDirectory);
  const nextjs = descriptor.framework === 'nextjs';
  if (
    dist === undefined ||
    (nextjs ? dist !== root : !inside(root, dist)) ||
    output.entry === undefined
  ) {
    throw new Error(`${descriptor.framework} produced no Node server output inside ${root}.`);
  }
  const entry = path.resolve(dist, output.entry);
  if (!inside(dist, entry) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error(
      `${descriptor.framework} did not write its server entry inside ${dist}: ${output.entry}`,
    );
  }
  const bundle = await assembleFrameworkArtifact(
    input,
    root,
    dist,
    entry,
    nextjs ? 'next' : 'output',
  );
  return {
    ...bundle,
    // The source root, plus what the wrapper bundled from outside it — the
    // contracts the service module imports from other modules.
    watch: [root, ...(bundle.watch ?? []).filter((file) => !inside(root, file))],
    watchIgnore: [...generatedState(root), nextjs ? path.join(root, '.next') : dist],
  };
}

export const frameworkBuild = (): ExtensionDescriptor => ({
  id: '@prisma/composer/frameworks',
  nodes: {
    framework: { kind: 'build', assemble },
  },
});
