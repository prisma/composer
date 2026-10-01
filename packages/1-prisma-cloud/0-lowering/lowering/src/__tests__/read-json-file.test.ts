import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile } from '../read-json-file.ts';

test('reads the current JSON artifact from a path containing URL delimiters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'composer-contract-'));
  const artifact = join(directory, 'contract #1.json');
  try {
    await writeFile(artifact, '{"version":1}');
    expect(await readJsonFile(artifact)).toEqual({ version: 1 });

    await writeFile(artifact, '{"version":2}');
    expect(await readJsonFile(artifact)).toEqual({ version: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
