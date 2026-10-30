import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { runPipeline } from '../pipeline.ts';
import prismaConfig from './fixtures/pipeline/prisma.config.ts';
import adaptersConfig from './fixtures/pipeline-config-adapters/prisma.config.ts';
import configPoolConfig from './fixtures/pipeline-config-pool/prisma.config.ts';

const fixtureDir = path.join(import.meta.dir, 'fixtures', 'pipeline');
const configPoolDir = path.join(import.meta.dir, 'fixtures', 'pipeline-config-pool');
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

  test('with no config list, runPipeline passes the process environment to Load as the config pool', async () => {
    const composer = configPoolConfig.composer;
    if (composer === undefined) throw new Error('the fixture declares a composer section');
    process.env['CONFIG_POOL_PROBE'] = 'probe';
    try {
      const { graph } = await runPipeline(
        undefined,
        undefined,
        'staging',
        configPoolDir,
        { value: composer, file: path.join(configPoolDir, 'prisma.config.ts') },
        { runAssembler: async () => ({ dir: '', entry: '' }) },
      );

      expect(graph.inputBindings[0]?.binding).toEqual({ greeting: 'probe' });
    } finally {
      delete process.env['CONFIG_POOL_PROBE'];
    }
  });

  test('runPipeline passes the config pool the adapters return to Load', async () => {
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
      expect(result.pools.config).toEqual({ CONFIG_POOL_PROBE: 'adapter' });
    } finally {
      delete process.env['CONFIG_POOL_PROBE'];
    }
  });

  test('runPipeline reads the secrets pool only when asked', async () => {
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
    expect(unread.pools.secrets).toEqual({});
    expect(called).toBe(0);

    const read = runPipeline(undefined, undefined, 'staging', adaptersDir, source, {
      ...noAssembly,
      readSecrets: true,
    });
    await expect(read).rejects.toMatchObject({ code: 'CONFIG.ADAPTER_FAILED' });
    expect(called).toBe(1);
  });
});
