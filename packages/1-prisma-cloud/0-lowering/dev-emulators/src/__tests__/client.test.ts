import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import getPort from 'get-port';
import { computeClient } from '../client.ts';
import { registryFilePath } from '../daemon.ts';
import { tempDir } from './helpers.ts';

describe('computeClient', () => {
  test('a registered emulator that refuses connections fails with DEV.EMULATOR_UNREACHABLE', async () => {
    const registryRoot = tempDir('client-unreachable');
    const port = await getPort();
    fs.writeFileSync(
      registryFilePath(registryRoot, 'compute'),
      JSON.stringify({ pid: process.pid, port, version: 'test', logPath: '/dev/null' }),
    );

    await expect(computeClient({ registryRoot }).health()).rejects.toMatchObject({
      name: 'CliStructuredError',
      code: 'DEV.EMULATOR_UNREACHABLE',
    });
  });
});
