import type alchemyPackage from '@alchemy.run/frontend-frameworks/package.json';
import type { BuildAdapter } from '@prisma/composer';

type NodeExport = Extract<keyof typeof alchemyPackage.exports, `./${string}/node`>;
export type Framework = NodeExport extends `./${infer Name}/node` ? Name : never;

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
