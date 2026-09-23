import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import alchemyPackage from '@alchemy.run/frontend-frameworks/package.json' with { type: 'json' };
import type { BuildAdapter } from '@internal/core';
import type { ExtensionDescriptor } from '@internal/core/config';
import type { AssembleInput, Bundle } from '@internal/core/deploy';
import * as NextjsControl from '@internal/nextjs/control';
import type { NodeBuildAdapter } from '@internal/node';
import * as NodeControl from '@internal/node/control';
import type { FrameworkBuildAdapter } from '../framework.ts';
import { nextjsBuildDescriptor } from '../nextjs.ts';
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

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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

/** Keep Composer's proven boot-wrapper and runtime tracing; never stage the project root. */
export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (!isFrameworkBuild(input.build)) {
    throw new Error('Expected a @prisma/composer/frameworks build descriptor.');
  }
  const descriptor = input.build;
  const moduleDir = path.dirname(fileURLToPath(descriptor.module));
  const root = await fs.promises.realpath(path.resolve(moduleDir, descriptor.root));
  const output = await buildFramework(descriptor.framework, root);

  if (descriptor.framework === 'nextjs') {
    // Next's upstream Node build reports the project root as distDirectory.
    // Composer's standalone assembler is the safe, existing packaging path.
    const build = nextjsBuildDescriptor(descriptor);
    const bundle = await NextjsControl.assemble({
      ...input,
      build,
    });
    return {
      ...bundle,
      watch: [root],
      watchIgnore: [...generatedState(root), path.join(root, '.next')],
    };
  }

  const dist = output.distDirectory === undefined ? undefined : path.resolve(output.distDirectory);
  if (dist === undefined || !inside(root, dist) || output.entry === undefined) {
    throw new Error(
      `${descriptor.framework} produced no dedicated Node server output inside ${root}.`,
    );
  }
  const entry = path.resolve(dist, output.entry);
  if (!inside(dist, entry) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error(
      `${descriptor.framework} did not write its server entry inside ${dist}: ${output.entry}`,
    );
  }
  const build: NodeBuildAdapter = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: descriptor.module,
    dir: path.relative(moduleDir, dist),
    entry: path.relative(dist, entry),
  };
  const bundle = await NodeControl.assemble({
    ...input,
    build,
  });
  return {
    ...bundle,
    watch: [root],
    watchIgnore: [...generatedState(root), dist],
  };
}

export const frameworkBuild = (): ExtensionDescriptor => ({
  id: '@prisma/composer/frameworks',
  nodes: {
    framework: { kind: 'build', assemble },
  },
});
