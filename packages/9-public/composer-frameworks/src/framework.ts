import type { BuildAdapter } from '@prisma/composer';

export const frameworkNames = ['astro', 'nextjs', 'nuxt', 'tanstack-start', 'vite'] as const;

export type Framework = (typeof frameworkNames)[number];

export function isFramework(value: unknown): value is Framework {
  return frameworkNames.some((framework) => framework === value);
}

export interface FrameworkBuildAdapter extends BuildAdapter {
  readonly type: 'framework';
  readonly framework: Framework;
  readonly root: string;
}

/** The root is resolved relative to the service module, not the deploy cwd. */
export default function frameworkBuild(options: {
  module: string;
  framework: Framework;
  root: string;
}): FrameworkBuildAdapter {
  return {
    extension: '@prisma/composer-frameworks',
    type: 'framework',
    module: options.module,
    framework: options.framework,
    root: options.root,
    entry: 'server.js',
  };
}
