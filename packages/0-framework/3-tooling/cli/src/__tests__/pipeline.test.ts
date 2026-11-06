import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { type Graph, GraphCheckError } from '@internal/core';
import { resolveAppIdentity, runPipeline } from '../pipeline.ts';
import { SecretRedaction } from '../redaction.ts';
import prismaConfig from './fixtures/pipeline/prisma.config.ts';
import appConfigurationConfig from './fixtures/pipeline-app-configuration/prisma.config.ts';
import adaptersConfig from './fixtures/pipeline-config-adapters/prisma.config.ts';

const fixtureDir = path.join(import.meta.dir, 'fixtures', 'pipeline');
const appConfigurationDir = path.join(import.meta.dir, 'fixtures', 'pipeline-app-configuration');
const adaptersDir = path.join(import.meta.dir, 'fixtures', 'pipeline-config-adapters');
const noAssembly = { runAssembler: async () => ({ dir: '', entry: '' }) };

describe('runPipeline()', () => {
  test('passes the environment into Load', async () => {
    const composer = prismaConfig.composer;
    if (composer === undefined) throw new Error('the fixture declares a composer section');

    const { graph } = await runPipeline(
      undefined,
      undefined,
      'staging',
      fixtureDir,
      { value: composer, file: path.join(fixtureDir, 'prisma.config.ts') },
      { runAssembler: async () => ({ dir: '', entry: '' }) },
    );

    expect(graph.inputBindings[0]?.binding).toEqual({ environment: 'deployed to staging' });
  });

  test('with no config list, runPipeline passes the process environment to Load as the app configuration', async () => {
    const composer = appConfigurationConfig.composer;
    if (composer === undefined) throw new Error('the fixture declares a composer section');
    process.env['CONFIG_POOL_PROBE'] = 'probe';
    try {
      const { graph } = await runPipeline(
        undefined,
        undefined,
        'staging',
        appConfigurationDir,
        { value: composer, file: path.join(appConfigurationDir, 'prisma.config.ts') },
        { runAssembler: async () => ({ dir: '', entry: '' }) },
      );

      expect(graph.inputBindings[0]?.binding).toEqual({ greeting: 'probe' });
    } finally {
      delete process.env['CONFIG_POOL_PROBE'];
    }
  });

  test('runPipeline passes the app configuration the adapters return to Load', async () => {
    const composer = adaptersConfig.composer;
    if (composer === undefined) throw new Error('the fixture declares a composer section');
    process.env['CONFIG_POOL_PROBE'] = 'shell';
    try {
      const result = await runPipeline(
        undefined,
        undefined,
        'staging',
        adaptersDir,
        { value: composer, file: path.join(adaptersDir, 'prisma.config.ts') },
        noAssembly,
      );

      expect(result.graph.inputBindings[0]?.binding).toEqual({ greeting: 'adapter' });
      expect(result.configuration).toEqual({ CONFIG_POOL_PROBE: 'adapter' });
    } finally {
      delete process.env['CONFIG_POOL_PROBE'];
    }
  });

  test('runPipeline reads the app secrets only when asked', async () => {
    const composer = adaptersConfig.composer;
    if (composer === undefined) throw new Error('the fixture declares a composer section');
    let called = 0;
    const source = {
      value: {
        ...composer,
        secrets: [
          () => {
            called += 1;
            throw new Error('vault down');
          },
        ],
      },
      file: path.join(adaptersDir, 'prisma.config.ts'),
    };

    const unread = await runPipeline(
      undefined,
      undefined,
      'staging',
      adaptersDir,
      source,
      noAssembly,
    );
    expect(unread.secrets).toEqual({});
    expect(called).toBe(0);

    const read = runPipeline(undefined, undefined, 'staging', adaptersDir, source, {
      ...noAssembly,
      readSecrets: true,
    });
    await expect(read).rejects.toMatchObject({ code: 'CONFIG.ADAPTER_FAILED' });
    expect(called).toBe(1);
  });

  test('runPipeline reads the app secrets before the app configuration', async () => {
    const composer = appConfigurationConfig.composer;
    if (composer === undefined) throw new Error('the fixture declares a composer section');
    const order: string[] = [];
    const source = {
      value: {
        ...composer,
        config: [
          () => {
            order.push('config');
            return { CONFIG_POOL_PROBE: 'probe' };
          },
        ],
        secrets: [
          () => {
            order.push('secrets');
            return {};
          },
        ],
      },
      file: path.join(appConfigurationDir, 'prisma.config.ts'),
    };

    await runPipeline(undefined, undefined, 'staging', appConfigurationDir, source, {
      ...noAssembly,
      readSecrets: true,
    });

    expect(order).toEqual(['secrets', 'config']);
  });

  test('runPipeline adds the values under every envSecret() name to the known secrets', async () => {
    const composer = appConfigurationConfig.composer;
    if (composer === undefined) throw new Error('the fixture declares a composer section');
    const redaction = new SecretRedaction({});
    const source = {
      value: {
        ...composer,
        config: [() => ({ CONFIG_POOL_PROBE: 'probe', S11_SECRET: 'from-config' })],
        secrets: [() => ({ S11_SECRET: 'from-secrets' })],
      },
      file: path.join(appConfigurationDir, 'prisma.config.ts'),
    };

    await runPipeline(undefined, undefined, 'staging', appConfigurationDir, source, {
      ...noAssembly,
      readSecrets: true,
      redaction,
    });

    expect([...redaction.knownSecrets.values()]).toContain('from-config');
    expect([...redaction.knownSecrets.values()]).toContain('from-secrets');
  });
});

describe('an extension graph check', () => {
  const composer = prismaConfig.composer;
  if (composer === undefined) throw new Error('the fixture declares a composer section');
  const file = path.join(fixtureDir, 'prisma.config.ts');
  const [fixtureExtension, ...otherExtensions] = composer.extensions;
  if (fixtureExtension === undefined) throw new Error('the fixture declares an extension');

  const withCheck = (checkGraph: (graph: Graph) => void, others = otherExtensions) => ({
    value: { ...composer, extensions: [{ ...fixtureExtension, checkGraph }, ...others] },
    file,
  });

  test('runPipeline hands every graph check the loaded graph', async () => {
    const checked: Graph[] = [];

    const { graph } = await runPipeline(
      undefined,
      undefined,
      'staging',
      fixtureDir,
      withCheck((loaded) => checked.push(loaded)),
      noAssembly,
    );

    expect(checked).toEqual([graph]);
  });

  test('a graph check that refuses the graph fails the pipeline as COMPOSE.GRAPH_INVALID with its message and extension id, before registry coverage and assemble', async () => {
    let assembled = false;
    const uncovered = withCheck(() => {
      throw new GraphCheckError('the graph is wrong');
    }, []);

    const run = runPipeline(undefined, undefined, 'staging', fixtureDir, uncovered, {
      runAssembler: async () => {
        assembled = true;
        return { dir: '', entry: '' };
      },
    });

    await expect(run).rejects.toMatchObject({
      code: 'COMPOSE.GRAPH_INVALID',
      message: 'the graph is wrong',
      meta: { extension: fixtureExtension.id },
    });
    expect(assembled).toBe(false);
  });

  test('any other throw from a graph check is a bug, and reaches the caller unchanged', async () => {
    const bug = new TypeError('cannot read properties of undefined');
    const broken = withCheck(() => {
      throw bug;
    });

    const run = runPipeline(undefined, undefined, 'staging', fixtureDir, broken, noAssembly);

    expect(await run.catch((error: unknown) => error)).toBe(bug);
  });

  test('a graph check runs after the known secrets are added', async () => {
    const appComposer = appConfigurationConfig.composer;
    if (appComposer === undefined) throw new Error('the fixture declares a composer section');
    const [appExtension, ...appOthers] = appComposer.extensions;
    if (appExtension === undefined) throw new Error('the fixture declares an extension');
    const redaction = new SecretRedaction({});
    let knownAtCheck: string[] = [];

    await runPipeline(
      undefined,
      undefined,
      'staging',
      appConfigurationDir,
      {
        value: {
          ...appComposer,
          extensions: [
            {
              ...appExtension,
              checkGraph: () => {
                knownAtCheck = [...redaction.knownSecrets.values()];
              },
            },
            ...appOthers,
          ],
          config: [() => ({ CONFIG_POOL_PROBE: 'probe' })],
          secrets: [() => ({ S11_SECRET: 'from-secrets' })],
        },
        file: path.join(appConfigurationDir, 'prisma.config.ts'),
      },
      { ...noAssembly, readSecrets: true, redaction },
    );

    expect(knownAtCheck).toContain('from-secrets');
  });

  test('resolveAppIdentity runs no graph check', async () => {
    let called = false;
    const source = withCheck(() => {
      called = true;
    });

    await resolveAppIdentity(undefined, undefined, fixtureDir, source);

    expect(called).toBe(false);
  });
});
