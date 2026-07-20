import { describe, expect, test } from 'bun:test';
import {
  containerEnv,
  containerEnvVarName,
  deserializeContainers,
} from '../container-transport.ts';
import type {
  ContainerInstance,
  ExtensionDescriptor,
  PrismaAppConfig,
} from '../exports/app-config.ts';

describe('containerEnvVarName()', () => {
  test('the documented mangling — the exact @prisma/composer-prisma-cloud expectation', () => {
    expect(containerEnvVarName('@prisma/composer-prisma-cloud')).toBe(
      'PRISMA_COMPOSER_CONTAINER_PRISMA_COMPOSER_PRISMA_CLOUD',
    );
  });

  test('uppercases and replaces non-alphanumeric runs with a single underscore', () => {
    expect(containerEnvVarName('acme.widgets/v2')).toBe(
      'PRISMA_COMPOSER_CONTAINER_ACME_WIDGETS_V2',
    );
  });

  test('trims leading/trailing underscores from the mangled id', () => {
    expect(containerEnvVarName('/leading-and-trailing/')).toBe(
      'PRISMA_COMPOSER_CONTAINER_LEADING_AND_TRAILING',
    );
  });
});

class FakeInstance implements ContainerInstance {
  constructor(
    readonly input: { appName: string; stage: string | undefined },
    private readonly payload: string,
  ) {}
  serialize(): string {
    return this.payload;
  }
}

describe('containerEnv()', () => {
  test('one env var per extension, keyed by its mangled id', () => {
    const instances = new Map<string, ContainerInstance>([
      ['ext-a', new FakeInstance({ appName: 'shop', stage: undefined }, 'serialized-a')],
      ['ext-b', new FakeInstance({ appName: 'shop', stage: 'staging' }, 'serialized-b')],
    ]);

    expect(containerEnv(instances)).toEqual({
      [containerEnvVarName('ext-a')]: 'serialized-a',
      [containerEnvVarName('ext-b')]: 'serialized-b',
    });
  });

  test('no resolved instances yields an empty env', () => {
    expect(containerEnv(new Map())).toEqual({});
  });

  test('two extension ids mangling to the same var name throws, naming both', () => {
    // '@a/b' and '@a.b' both mangle to 'PRISMA_COMPOSER_CONTAINER_A_B'.
    const instances = new Map<string, ContainerInstance>([
      ['@a/b', new FakeInstance({ appName: 'shop', stage: undefined }, 'x')],
      ['@a.b', new FakeInstance({ appName: 'shop', stage: undefined }, 'y')],
    ]);

    expect(() => containerEnv(instances)).toThrow(/@a\/b/);
    expect(() => containerEnv(instances)).toThrow(/@a\.b/);
  });

  test('an instance whose serialize() returns an empty string throws, naming the extension', () => {
    const instances = new Map<string, ContainerInstance>([
      ['ext-a', new FakeInstance({ appName: 'shop', stage: undefined }, '')],
    ]);

    expect(() => containerEnv(instances)).toThrow(/ext-a/);
  });
});

function configWithContainerExtension(id: string): PrismaAppConfig {
  const descriptor: ExtensionDescriptor = {
    id,
    nodes: {},
    container: {
      ensure: () => {
        throw new Error('ensure() must not run in deserializeContainers()');
      },
      locate: () => {
        throw new Error('locate() must not run in deserializeContainers()');
      },
      remove: () => {
        throw new Error('remove() must not run in deserializeContainers()');
      },
      deserialize: (serialized) => {
        const input = JSON.parse(serialized) as { appName: string; stage: string | undefined };
        return new FakeInstance(input, serialized);
      },
    },
  };
  return {
    extensions: [descriptor],
    state: {
      extension: id,
      create: () => {
        throw new Error('state.create() must not run in this test');
      },
    },
  };
}

describe('deserializeContainers()', () => {
  test('a config extension with a container descriptor whose var is present deserializes it', () => {
    const config = configWithContainerExtension('ext-a');
    const serialized = JSON.stringify({ appName: 'shop', stage: undefined });

    const instances = deserializeContainers(config.extensions, {
      [containerEnvVarName('ext-a')]: serialized,
    });

    expect(instances.size).toBe(1);
    expect(instances.get('ext-a')?.serialize()).toBe(serialized);
  });

  test('an absent var means no entry for that extension', () => {
    const config = configWithContainerExtension('ext-a');

    const instances = deserializeContainers(config.extensions, {});

    expect(instances.has('ext-a')).toBe(false);
  });

  test('an extension declaring no container descriptor is never looked up', () => {
    const config: PrismaAppConfig = {
      extensions: [{ id: 'ext-no-container', nodes: {} }],
      state: {
        extension: 'ext-no-container',
        create: () => {
          throw new Error('unused');
        },
      },
    };

    const instances = deserializeContainers(config.extensions, {
      [containerEnvVarName('ext-no-container')]: 'anything',
    });

    expect(instances.size).toBe(0);
  });

  test('round trip: containerEnv()  →  deserializeContainers() reconstructs the same serialized payload', () => {
    const config = configWithContainerExtension('ext-a');
    const original = new FakeInstance(
      { appName: 'shop', stage: 'staging' },
      JSON.stringify({ appName: 'shop', stage: 'staging' }),
    );
    const env = containerEnv(new Map([['ext-a', original]]));

    const instances = deserializeContainers(config.extensions, env);

    expect(instances.get('ext-a')?.serialize()).toBe(original.serialize());
  });
});
