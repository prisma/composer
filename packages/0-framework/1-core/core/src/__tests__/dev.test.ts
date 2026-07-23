import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type {
  DevExtensionDescriptor,
  ExtensionDescriptor,
  PrismaAppConfig,
} from '../control/app-config.ts';
import type { AlchemyStateLayer } from '../control/deploy.ts';
import { devProviders, resolveDevDescriptors } from '../control/dev.ts';

const stateSentinel = (tag: string): AlchemyStateLayer =>
  ({ __sentinel: tag }) as unknown as AlchemyStateLayer;

// A build-only extension: every `nodes` entry is `kind: 'build'`, and none
// of `providers`/`application`/`provisions`/`container` are declared — the
// exact shape `nodeBuild()` uses (ADR-0041's build-only exemption).
const buildOnlyExtension = (id = 'test/build-only'): ExtensionDescriptor => ({
  id,
  nodes: { node: { kind: 'build', assemble: () => Promise.reject(new Error('unused')) } },
});

const fakeDevDescriptor = (): DevExtensionDescriptor => ({
  providers: () => Layer.empty,
  container: {
    ensure: () => {
      throw new Error('ensure() must not run here');
    },
    locate: () => {
      throw new Error('locate() must not run here');
    },
    remove: () => {
      throw new Error('remove() must not run here');
    },
    deserialize: () => {
      throw new Error('deserialize() must not run here');
    },
  },
  attach: () => Promise.reject(new Error('unused')),
});

// The `dev` field is a lazy thunk (ADR-0041's lazy dev reference) — this
// stand-in resolves it immediately, mirroring the shape of a real
// `() => import('...').then((m) => m.devDescriptor())` without an actual
// dynamic import. A real (non-build) node — `nodes: {}` alone is vacuously
// build-only (isBuildOnlyExtension) and would be skipped before its `dev`
// thunk was ever read, defeating the point of this fixture.
const devCapableExtension = (id = 'test/dev-pack'): ExtensionDescriptor => ({
  id,
  nodes: {
    'fake/resource': Object.assign(() => Effect.succeed({ outputs: {}, entities: [] }), {
      kind: 'resource' as const,
    }),
  },
  dev: () => Promise.resolve(fakeDevDescriptor()),
});

// A minimal, non-build-only extension with no `dev` descriptor — a plain
// resource node, no providers.
const nonDevExtension = (id = 'test/pack'): ExtensionDescriptor => ({
  id,
  nodes: {
    'fake/resource': Object.assign(() => Effect.succeed({ outputs: {}, entities: [] }), {
      kind: 'resource' as const,
    }),
  },
});

describe('resolveDevDescriptors', () => {
  test('a dev-capable extension plus a build-only extension resolves without error — the build-only extension is skipped, never even asked for a thunk', () => {
    const dev = devCapableExtension();
    const buildOnly = buildOnlyExtension();
    const config: PrismaAppConfig = {
      extensions: [dev, buildOnly],
      state: { extension: dev.id, create: () => stateSentinel('config') },
    };

    return resolveDevDescriptors(config).then((resolved) => {
      expect([...resolved.keys()]).toEqual(['test/dev-pack']);
    });
  });

  test('an extension with a non-build node and no dev thunk throws the pinned no-dev-support message', async () => {
    const bare = nonDevExtension();
    const config: PrismaAppConfig = {
      extensions: [bare],
      state: { extension: bare.id, create: () => stateSentinel('config') },
    };

    await expect(resolveDevDescriptors(config)).rejects.toThrow(
      'extension "test/pack" has no dev support — it declares no `dev` descriptor (ADR-0041).',
    );
  });
});

describe('devProviders', () => {
  test("merges the resolved descriptors' providers layers without error", async () => {
    const dev = devCapableExtension();
    const config: PrismaAppConfig = {
      extensions: [dev],
      state: { extension: dev.id, create: () => stateSentinel('config') },
    };
    const resolved = await resolveDevDescriptors(config);

    expect(devProviders(resolved, new Map(), '/tmp/dev')).toBeDefined();
  });

  test('an empty resolved map yields the empty layer', () => {
    expect(devProviders(new Map(), new Map(), '/tmp/dev')).toBe(Layer.empty);
  });
});
