import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { runPipeline } from '../pipeline.ts';
import prismaConfig from './fixtures/pipeline/prisma.config.ts';
import configPoolConfig from './fixtures/pipeline-config-pool/prisma.config.ts';

const fixtureDir = path.join(import.meta.dir, 'fixtures', 'pipeline');
const configPoolDir = path.join(import.meta.dir, 'fixtures', 'pipeline-config-pool');

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

  test('runPipeline passes the process environment to Load as the config pool', async () => {
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
});
