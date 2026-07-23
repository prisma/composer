// One-off restart-latency measurement (S6 Part B). Mirrors
// test/integration/test/local-dev-store.integration.ts's
// `rebuildCatalogAndReconverge` technique exactly: touch catalog's built
// artifact, re-run the node build adapter's own `assemble()` for
// catalog.service, re-converge the SAME dev stack file directly with the
// real `alchemy` binary (session stays up throughout — no CLI
// re-invocation, no SIGINT), then poll the compute emulator's services
// listing until catalog.service's pid changes. Not committed as a test;
// run once by hand to produce the numbers recorded in latency.md.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { containerEnv } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud } from '@prisma/composer-prisma-cloud/control';

// Run this script with `examples/store` as cwd (module resolution needs its
// node_modules; the S6 proof ran it as a temp copy inside that directory).
const storeDir = process.cwd();
const DEV_STACK_FILE = path.join(storeDir, '.prisma-composer', 'dev', 'alchemy.run.ts');
const catalogServiceModule = path.join(storeDir, 'modules', 'catalog', 'src', 'service.ts');
const APP_NAME = 'store';

function alchemyBin(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'alchemy');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`could not find alchemy above ${startDir}`);
    dir = parent;
  }
}

interface EmulatorRegistryEntry {
  readonly pid: number;
  readonly port: number;
}
function isRegistryEntry(value: unknown): value is EmulatorRegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  if (!('pid' in value) || !('port' in value)) return false;
  return typeof value.pid === 'number' && typeof value.port === 'number';
}
function readComputeEntry(): EmulatorRegistryEntry {
  const p = path.join(os.homedir(), '.prisma-composer', 'emulators', 'compute.json');
  const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!isRegistryEntry(parsed)) throw new Error('bad compute registry entry');
  return parsed;
}

interface ServiceInfo {
  readonly address: string;
  readonly status: string;
  readonly pid?: number;
}
function isServiceInfoArray(value: unknown): value is ServiceInfo[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) => typeof v === 'object' && v !== null && 'address' in v && typeof v.address === 'string',
    )
  );
}
async function pidsByAddress(): Promise<Record<string, number | undefined>> {
  const entry = readComputeEntry();
  const res = await fetch(`http://127.0.0.1:${entry.port}/apps/${APP_NAME}/services`);
  if (!res.ok) throw new Error(`listServices failed: ${res.status}`);
  const parsed: unknown = await res.json();
  if (!isServiceInfoArray(parsed)) throw new Error('unexpected services listing shape');
  return Object.fromEntries(parsed.map((s) => [s.address, s.pid]));
}

async function waitForAsync<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function oneRun(runNumber: number): Promise<number> {
  const before = await pidsByAddress();
  const pidBefore = before['catalog.service'];

  const t0 = performance.now();

  // 1. Edit the source (a real edit, not just a rebuild trigger). A plain
  // comment doesn't survive `bun build --production`'s minifier, so the
  // rebuilt bytes (and thus the artifact hash) wouldn't actually move —
  // append a side-effecting statement instead, guaranteed to survive
  // minification (dead-code elimination can't drop a console.log).
  const marker = `latency-probe-run-${runNumber}-${Date.now()}`;
  const serverSrc = catalogServiceModule.replace('service.ts', 'server.ts');
  fs.appendFileSync(serverSrc, `\nconsole.log("${marker}");\n`);

  // 2. Rebuild via the example's own build script.
  const build = spawnSync('bun', ['run', 'build'], {
    cwd: path.join(storeDir, 'modules', 'catalog'),
    stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('catalog build failed');

  // 3. Re-assemble (copies the freshly built dist/ into the dev bundle dir).
  const buildDescriptor = nodeBuild().nodes['node'];
  if (buildDescriptor === undefined || buildDescriptor.kind !== 'build') {
    throw new Error('nodeBuild() must declare a "node" build descriptor');
  }
  await buildDescriptor.assemble({
    build: {
      extension: '@prisma/composer/node',
      type: 'node',
      module: `file://${catalogServiceModule}`,
      entry: '../dist/server.mjs',
    },
    address: 'catalog.service',
    cwd: storeDir,
  });

  // 4. Re-converge (this is what the CLI's own watch loop would do).
  // (The measured run used the pre-rename seam, `descriptor.dev`, on the S5
  // branch; updated here to main's `localTarget` thunk — same call, new name.)
  const descriptor = prismaCloud();
  if (descriptor.localTarget === undefined) throw new Error('no local-target descriptor');
  const localTarget = await descriptor.localTarget();
  const container = await localTarget.container.ensure({ appName: APP_NAME, stage: undefined });
  const envVars = containerEnv(new Map([[descriptor.id, container]]));
  const result = spawnSync(
    alchemyBin(storeDir),
    ['deploy', path.relative(storeDir, DEV_STACK_FILE), '--yes', '--stage', 'dev'],
    { cwd: storeDir, stdio: 'inherit', env: { ...process.env, ...envVars } },
  );
  if (result.status !== 0) throw new Error(`converge failed: ${result.status}`);

  // 5. Poll until catalog.service's pid actually changes (new process serving).
  await waitForAsync(async () => {
    const pids = await pidsByAddress();
    const pidAfter = pids['catalog.service'];
    return pidAfter !== undefined && pidAfter !== pidBefore ? pidAfter : undefined;
  }, 30_000);

  const t1 = performance.now();
  return t1 - t0;
}

async function main(): Promise<void> {
  const runs = 5;
  const results: number[] = [];
  for (let i = 1; i <= runs; i += 1) {
    const ms = await oneRun(i);
    console.log(`[latency] run ${i}: ${(ms / 1000).toFixed(2)}s`);
    results.push(ms);
  }
  const sorted = [...results].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`[latency] median: ${((median ?? 0) / 1000).toFixed(2)}s`);
  console.log(JSON.stringify(results));
}

await main();
