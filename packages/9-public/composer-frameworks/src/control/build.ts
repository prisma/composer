import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import type * as FileSystem from 'effect/FileSystem';
import type * as Path from 'effect/Path';
import type { Framework } from '../framework.ts';

type BuildService = {
  build(options: { root: string }): Effect.Effect<
    {
      distDirectory?: string;
      serverModules?: ReadonlyArray<{ name: string }>;
    },
    unknown
  >;
};

type FrameworkFactory = (options: {
  root: string;
  target?: unknown;
}) => Effect.Effect<BuildService, unknown, FileSystem.FileSystem | Path.Path>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFactory(value: unknown): value is FrameworkFactory {
  return typeof value === 'function';
}

function isNodeTargetFactory(value: unknown): value is () => unknown {
  return typeof value === 'function';
}

export async function buildFramework(framework: Framework, root: string) {
  const build = Effect.gen(function* () {
    const node: unknown = yield* Effect.promise(
      () => import(`@alchemy.run/frontend-frameworks/${framework}/node`),
    );
    if (!isRecord(node)) {
      throw new Error(`Alchemy ${framework}/node did not export a module.`);
    }
    const service = isFactory(node['make'])
      ? yield* node['make']({ root })
      : yield* Effect.gen(function* () {
          if (!isNodeTargetFactory(node['makeNodeTarget'])) {
            throw new Error(`Alchemy ${framework}/node has no Node target factory.`);
          }
          const integration = yield* Effect.promise(
            () => import(`@alchemy.run/frontend-frameworks/${framework}`),
          );
          if (!isRecord(integration) || !isFactory(integration['make'])) {
            throw new Error(`Alchemy ${framework} has no framework factory.`);
          }
          return yield* integration['make']({ root, target: node['makeNodeTarget']() });
        });
    return yield* service.build({ root });
  });
  const output = await Effect.runPromise(build.pipe(Effect.provide(NodeServices.layer)));
  return { distDirectory: output.distDirectory, entry: output.serverModules?.[0]?.name };
}
