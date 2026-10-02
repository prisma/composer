import { readFile } from 'node:fs/promises';

/** Read a generated JSON artifact on every call, without ESM module caching. */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
