import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { assemble } from '@prisma/composer/node/control';
import webService from '../src/service.ts';

const tmpDirs: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) {
    process.kill();
    await process.exited;
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (address === null || typeof address === 'string')
    throw new Error('failed to reserve a TCP port');
  return address.port;
}

async function fetchWhenReady(url: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Nitro has not started listening yet.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Nitro did not serve ${url} within 10 seconds`);
}

describe('TanStack Start directory build', () => {
  test('assembles the complete Nitro output and selects its server entry', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-tanstack-start-'));
    tmpDirs.push(cwd);

    const artifact = await assemble({ build: webService.build, address: 'web', cwd });

    expect(artifact.entry).toBe('bundle/server/index.mjs');
    expect(fs.existsSync(path.join(artifact.dir, 'main.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(artifact.dir, 'bundle', 'nitro.json'))).toBe(true);
    expect(
      fs.readFileSync(path.join(artifact.dir, 'bundle', 'public', 'composer.txt'), 'utf8'),
    ).toBe('tanstack-start-composer-public-asset\n');
  }, 20_000);

  test('the built Nitro server renders SSR and serves its public tree', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-tanstack-start-'));
    tmpDirs.push(cwd);
    const artifact = await assemble({ build: webService.build, address: 'web', cwd });

    const port = await freePort();
    const child = Bun.spawn([process.execPath, path.join(artifact.dir, artifact.entry)], {
      cwd: artifact.dir,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    processes.push(child);

    const origin = `http://127.0.0.1:${port}`;
    const html = await (await fetchWhenReady(origin)).text();
    expect(html).toContain('TanStack Start on Prisma Composer');

    const asset = await (await fetchWhenReady(`${origin}/composer.txt`)).text();
    expect(asset).toBe('tanstack-start-composer-public-asset\n');
  }, 20_000);
});
