/**
 * The Durable Streams conformance suite against the local stand-in — proves
 * the module's local-dev path speaks the same protocol as the deployed
 * server. Mirrors the server repo's conformance.local.vitest.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConformanceTests } from '@durable-streams/server-conformance-tests';
import { afterAll, beforeAll } from 'vitest';
import { type LocalStreamsServer, startLocalStreamsServer } from '../src/testing.ts';

const baseUrl = 'http://127.0.0.1:8791';

let server: LocalStreamsServer | null = null;
let dataRoot: string | null = null;
let prevDataRoot: string | undefined;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'streams-conformance-'));
  prevDataRoot = process.env['DS_LOCAL_DATA_ROOT'];
  process.env['DS_LOCAL_DATA_ROOT'] = dataRoot;
  server = await startLocalStreamsServer({
    name: 'conformance',
    hostname: '127.0.0.1',
    port: 8791,
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
  server = null;
  if (prevDataRoot === undefined) delete process.env['DS_LOCAL_DATA_ROOT'];
  else process.env['DS_LOCAL_DATA_ROOT'] = prevDataRoot;
  if (dataRoot !== null) rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = null;
}, 60_000);

runConformanceTests({ baseUrl });
