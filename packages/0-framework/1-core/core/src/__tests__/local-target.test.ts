import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type {
  ExtensionDescriptor,
  LocalTargetDescriptor,
  PrismaAppConfig,
} from '../control/app-config.ts';
import type { AlchemyStateLayer } from '../control/deploy.ts';
import { localTargetProviders, resolveLocalTargets } from '../control/local-target.ts';

const stateSentinel = (tag: string): AlchemyStateLayer =>
  ({ __sentinel: tag }) as unknown as AlchemyStateLayer;

// A build-only extension: every `nodes` entry is `kind: 'build'`, and none
// of `providers`/`application`/`provisions`/`container` are declared — the
// exact shape `nodeBuild()` uses (ADR-0041's build-only exemption).
const buildOnlyExtension = (id = 'test/build-only'): ExtensionDescriptor => ({
  id,
  nodes: { node: { kind: 'build', assemble: () => Promise.reject(new Error('unused')) } },
});

const fakeLocalTargetDescriptor = (): LocalTargetDescriptor => ({
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

// The `localTarget` field is a lazy thunk (ADR-0041's lazy local-target
// reference) — this stand-in resolves it immediately, mirroring the shape
// of a real `() => import('...').then((m) => m.localTargetDescriptor())`
// without an actual dynamic import. A real (non-build) node — `nodes: {}`
// alone is vacuously build-only (isBuildOnlyExtension) and would be skipped
// before its `localTarget` thunk was ever read, defeating the point of this
// fixture.
const localTargetCapableExtension = (id = 'test/dev-pack'): ExtensionDescriptor => ({
  id,
  nodes: {
    'fake/resource': Object.assign(() => Effect.succeed({ outputs: {}, entities: [] }), {
      kind: 'resource' as const,
    }),
  },
  localTarget: () => Promise.resolve(fakeLocalTargetDescriptor()),
});

// A minimal, non-build-only extension with no `localTarget` descriptor — a
// plain resource node, no providers.
const nonLocalTargetExtension = (id = 'test/pack'): ExtensionDescriptor => ({
  id,
  nodes: {
    'fake/resource': Object.assign(() => Effect.succeed({ outputs: {}, entities: [] }), {
      kind: 'resource' as const,
    }),
  },
});

describe('resolveLocalTargets', () => {
  test('a local-target-capable extension plus a build-only extension resolves without error — the build-only extension is skipped, never even asked for a thunk', () => {
    const localTarget = localTargetCapableExtension();
    const buildOnly = buildOnlyExtension();
    const config: PrismaAppConfig = {
      extensions: [localTarget, buildOnly],
      state: { extension: localTarget.id, create: () => stateSentinel('config') },
    };

    return resolveLocalTargets(config).then((resolved) => {
      expect([...resolved.keys()]).toEqual(['test/dev-pack']);
    });
  });

  test('an extension with a non-build node and no localTarget thunk throws the pinned no-dev-support message', async () => {
    const bare = nonLocalTargetExtension();
    const config: PrismaAppConfig = {
      extensions: [bare],
      state: { extension: bare.id, create: () => stateSentinel('config') },
    };

    await expect(resolveLocalTargets(config)).rejects.toThrow(
      'extension "test/pack" has no dev support — it declares no `localTarget` descriptor (ADR-0041).',
    );
  });
});

describe('localTargetProviders', () => {
  test("merges the resolved descriptors' providers layers without error", async () => {
    const localTarget = localTargetCapableExtension();
    const config: PrismaAppConfig = {
      extensions: [localTarget],
      state: { extension: localTarget.id, create: () => stateSentinel('config') },
    };
    const resolved = await resolveLocalTargets(config);

    expect(localTargetProviders(resolved, new Map(), '/tmp/dev')).toBeDefined();
  });

  test('an empty resolved map yields the empty layer', () => {
    expect(localTargetProviders(new Map(), new Map(), '/tmp/dev')).toBe(Layer.empty);
  });
});
