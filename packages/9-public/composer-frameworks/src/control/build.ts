import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import type { Framework } from '../framework.ts';

export async function buildFramework(framework: Framework, root: string) {
  const build = Effect.gen(function* () {
    switch (framework) {
      case 'astro': {
        const [integration, node] = yield* Effect.promise(() =>
          Promise.all([
            import('@alchemy.run/frontend-frameworks/astro'),
            import('@alchemy.run/frontend-frameworks/astro/node'),
          ]),
        );
        const service = yield* integration.make({ root, target: node.makeNodeTarget() });
        return yield* service.build({ root });
      }
      case 'nextjs': {
        const node = yield* Effect.promise(
          () => import('@alchemy.run/frontend-frameworks/nextjs/node'),
        );
        const service = yield* node.make({ root });
        return yield* service.build({ root });
      }
      case 'nuxt': {
        const [integration, node] = yield* Effect.promise(() =>
          Promise.all([
            import('@alchemy.run/frontend-frameworks/nuxt'),
            import('@alchemy.run/frontend-frameworks/nuxt/node'),
          ]),
        );
        const service = yield* integration.make({ root, target: node.makeNodeTarget() });
        return yield* service.build({ root });
      }
      case 'tanstack-start': {
        const [integration, node] = yield* Effect.promise(() =>
          Promise.all([
            import('@alchemy.run/frontend-frameworks/tanstack-start'),
            import('@alchemy.run/frontend-frameworks/tanstack-start/node'),
          ]),
        );
        const service = yield* integration.make({ root, target: node.makeNodeTarget() });
        return yield* service.build({ root });
      }
      case 'vite': {
        const [integration, node] = yield* Effect.promise(() =>
          Promise.all([
            import('@alchemy.run/frontend-frameworks/vite'),
            import('@alchemy.run/frontend-frameworks/vite/node'),
          ]),
        );
        const service = yield* integration.make({ root, target: node.makeNodeTarget() });
        return yield* service.build({ root });
      }
    }
  });
  const output = await Effect.runPromise(build.pipe(Effect.provide(NodeServices.layer)));
  return { distDirectory: output.distDirectory, entry: output.serverModules?.[0]?.name };
}
