import type { NextjsBuildAdapter } from '@internal/nextjs';

export type NextjsFrameworkBuild = {
  readonly module: string;
  readonly root: string;
  readonly framework: string;
};

export function nextjsBuildDescriptor(build: NextjsFrameworkBuild): NextjsBuildAdapter {
  if (build.framework !== 'nextjs') {
    throw new Error('Expected a Next.js framework build descriptor.');
  }
  return {
    extension: '@internal/nextjs',
    type: 'nextjs',
    module: build.module,
    appDir: build.root,
    entry: 'server.js',
  };
}
