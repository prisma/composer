#!/usr/bin/env bun
/**
 * Canary for FT-5226 (PPg cold-connect rejection). Provisions a fresh project
 * and SAMPLES several fresh cold databases: each makes ONE bare `pg` connect
 * with no retry. FT-5226 is intermittent (the edge proxy rejects a cold DB's
 * first connect while its upstream warms, but a fast connect occasionally slips
 * through), so a single connect can't tell "fixed" from "got lucky once". The
 * run is judged unanimously (see classifyColdConnectRun) with a REQUIRED
 * check's exits: any active rejection → exit 0 (bug still present); ALL of at
 * least MIN_BUG_GONE_SAMPLES samples succeeding → exit 1, the forcing signal
 * to remove `withConnectionRetry`
 * (packages/1-prisma-cloud/1-extensions/target/src/pg-connection.ts) and this
 * canary; inconclusive → exit 0 with a CI warning annotation, so a flake
 * never blocks unrelated PRs. Sampling is adaptive: the first rejection ends
 * the run, and only an all-success streak keeps going to the full depth.
 *
 * Exit 1 is therefore a live instruction to delete production code, so it must
 * mean a bug-gone verdict and nothing else. Every other outcome — a canary that
 * cannot provision, a teardown that fails, a stray async error — exits 0 with
 * the reason logged. See the uncaught-error handlers below for why that needs
 * explicit work under bun.
 */
import pg from 'pg';
import { deleteProjectDeep, type HttpCall, type ProjectRef } from './ci-cleanup-utils.ts';
import {
  type ColdConnectSample,
  type ColdConnectVerdict,
  classifyColdConnectRun,
  classifyColdConnectSample,
  collectColdConnectSamples,
} from './cold-connect-canary-classify.ts';

// bun exits 1 on any uncaught error or unhandled rejection, whatever
// process.exitCode says — which silently turns a stray socket error into this
// script's "delete withConnectionRetry" signal. Absorbing them here keeps the
// exit code equal to the verdict; the run's own failures are caught below, so
// nothing that decides the verdict reaches these handlers.
process.on('uncaughtException', (error) => {
  console.error('Uncaught error — logged only, the verdict decides the exit code:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection — logged only, the verdict decides the exit code:', reason);
});

const API = 'https://api.prisma.io/v1';
const REGION = 'us-east-1';

/**
 * A misspelt override would otherwise become NaN, and NaN quietly disables the
 * very things it names: `setTimeout(NaN)` fires at once, killing the spacing,
 * and every comparison against a NaN budget is false, so the run never stops
 * itself. Refuse to start instead — non-blocking, like every other way this
 * canary can fail to reach a verdict.
 */
function positiveNumber(name: string, fallback: number, integer = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  const ok = Number.isFinite(value) && value > 0 && (!integer || Number.isSafeInteger(value));
  if (!ok) {
    const wanted = integer ? 'a positive whole number' : 'a positive number';
    console.error(`${name} must be ${wanted}; got "${raw}".`);
    console.log(
      `::warning title=Cold-connect canary (FT-5226) could not run::${name} must be ${wanted}; ` +
        `got "${raw}" — no FT-5226 verdict this run; not blocking.`,
    );
    process.exit(0);
  }
  return value;
}

const SAMPLES = positiveNumber('COLD_CONNECT_SAMPLES', 5, true);
/**
 * Spacing between samples. Back-to-back sampling produced a false bug-gone
 * verdict on 2026-08-09 (run 31330072181, 14/14 successes) while runs minutes
 * either side of it still saw the rejection: across 20 runs the successes came
 * back in a median of 122ms against 546ms for rejections, so the quick ones
 * were reaching an already-warm upstream and testing nothing. A sample that
 * never met a cold database is not evidence the cold-connect bug is gone.
 *
 * 60s is the sibling cold-start canary's interval (SAMPLE_INTERVAL_MS there),
 * adopted for the same reason rather than derived from measurement here — if
 * false bug-gone verdicts persist, that is the number to re-derive first.
 *
 * The pause belongs BETWEEN samples. Never put one between provisioning a
 * database and connecting to it: that warms the very thing under test.
 */
const SAMPLE_INTERVAL_MS = positiveNumber('COLD_CONNECT_SAMPLE_INTERVAL_MS', 60_000);
/** The run's own wall-clock budget, below the job's timeout so the script stops itself and still reports. */
const MAX_RUN_MS = positiveNumber('COLD_CONNECT_MAX_RUN_MS', 900_000);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const token = process.env['PRISMA_SERVICE_TOKEN'];
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
if (!token || !workspaceId) {
  // Exit 0, not 1: a run with no credentials sampled nothing, and exit 1 would
  // tell the reader to delete withConnectionRetry on the strength of it.
  console.error('PRISMA_SERVICE_TOKEN and PRISMA_WORKSPACE_ID are required');
  console.log(
    '::warning title=Cold-connect canary (FT-5226) could not run::PRISMA_SERVICE_TOKEN and ' +
      'PRISMA_WORKSPACE_ID are required — no FT-5226 verdict this run; not blocking.',
  );
  process.exit(0);
}

const runId = process.env['GITHUB_RUN_ID'] ?? `${process.pid}${Math.floor(Math.random() * 1000)}`;
const projectName = `canary-ci-${runId}`;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${API}${path}`, init);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function apiData(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await api(method, path, body);
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  const json: unknown = await res.json();
  const data = isRecord(json) ? json['data'] : undefined;
  if (!isRecord(data)) {
    throw new Error(`${method} ${path} returned an unexpected body: ${JSON.stringify(json)}`);
  }
  return data;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`expected "${key}" to be a string`);
  return value;
}

const http: HttpCall = async (method, path) => {
  const res = await api(method, path);
  return { status: res.status, ok: res.ok, body: await res.text() };
};

function connectionStringOf(endpoint: unknown): string | undefined {
  if (!isRecord(endpoint)) return undefined;
  const value = endpoint['connectionString'];
  return typeof value === 'string' ? value : undefined;
}

/** Provisions one fresh cold database under `projectId` and returns its first-connect outcome. */
async function sampleColdConnect(projectId: string, index: number): Promise<ColdConnectSample> {
  const createdDb = await apiData('POST', `/projects/${projectId}/databases`, {
    name: `probe${index}`,
    region: REGION,
  });
  const databaseId = requireString(createdDb, 'id');
  const createdConn = await apiData('POST', `/databases/${databaseId}/connections`, {
    name: 'canary',
  });
  const endpoints = createdConn['endpoints'];
  const dsn =
    connectionStringOf(isRecord(endpoints) ? endpoints['direct'] : undefined) ??
    connectionStringOf(isRecord(endpoints) ? endpoints['pooled'] : undefined);
  if (!dsn) throw new Error('connection returned no direct/pooled connection string');

  const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  // PPg sometimes accepts the connect and then drops the socket. pg reports
  // that as an 'error' event on the client, and an 'error' event with no
  // listener is an uncaught exception. The connect/query failure below is what
  // classifies the sample; this listener only keeps the report from killing us.
  client.on('error', (error: Error) => {
    console.log(`  sample #${index}: client reported a socket error — ${error.message}`);
  });
  let connectError: unknown;
  const started = Date.now();
  try {
    await client.connect();
    await client.query('select 1');
    await client.end();
  } catch (error) {
    connectError = error;
    try {
      await client.end();
    } catch {
      // already dead
    }
  }
  const sample = classifyColdConnectSample(connectError);
  const detail = connectError instanceof Error ? ` — ${connectError.message}` : '';
  console.log(`  sample #${index}: ${sample} (${Date.now() - started}ms)${detail}`);
  return sample;
}

let project: ProjectRef | undefined;

/** Provisions the project, samples until the verdict is settled, and reports it. */
async function runCanary(): Promise<ColdConnectVerdict> {
  const createdProject = await apiData('POST', '/projects', {
    name: projectName,
    workspaceId,
  });
  const created: ProjectRef = {
    id: requireString(createdProject, 'id'),
    name: requireString(createdProject, 'name'),
  };
  project = created;
  console.log(`Created project "${created.name}" (${created.id}); sampling ${SAMPLES} cold DBs…`);

  const samples = await collectColdConnectSamples({
    sample: (index) => sampleColdConnect(created.id, index),
    sleep,
    now: () => Date.now(),
    minSamples: SAMPLES,
    intervalMs: SAMPLE_INTERVAL_MS,
    maxRunMs: MAX_RUN_MS,
    log: (line) => console.log(line),
  });

  const result = classifyColdConnectRun(samples);
  console.log(result.message);
  if (result.verdict === 'inconclusive') {
    const detail = samples.map((sample, i) => `sample #${i}: ${sample}`).join('; ');
    console.log(
      `::warning title=Cold-connect canary (FT-5226) inconclusive::${result.message} [${detail}]`,
    );
  }
  return result.verdict;
}

/**
 * Teardown is best-effort: a leftover project costs one workspace slot until
 * the CI cleanup job's next sweep of the `canary` prefix, which is not worth
 * overturning a verdict the run already reached.
 */
async function deleteCanaryProject(): Promise<void> {
  if (!project) return;
  console.log(`Deleting project "${project.name}" (${project.id})…`);
  const leaked = `canary project "${project.name}" (${project.id}) — the CI cleanup job sweeps the "canary" prefix.`;
  try {
    const deleted = await deleteProjectDeep(http, project, { log: (line) => console.error(line) });
    if (!deleted) console.error(`Could not delete ${leaked}`);
  } catch (error) {
    console.error(`Deleting ${leaked}\n  the delete threw:`, error);
  }
}

let verdict: ColdConnectVerdict;
try {
  verdict = await runCanary();
} catch (error) {
  // No samples means no verdict, so there is nothing to report about FT-5226 —
  // and claiming bug-gone here would tell someone to delete a workaround this
  // run never tested. Same treatment as inconclusive: loud, but not blocking.
  console.error('Cold-connect canary failed before reaching a verdict:', error);
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ');
  console.log(
    `::warning title=Cold-connect canary (FT-5226) could not run::${detail} — no FT-5226 ` +
      'verdict this run; not blocking. Keep withConnectionRetry.',
  );
  verdict = 'inconclusive';
} finally {
  await deleteCanaryProject();
}

process.exitCode = verdict === 'bug-gone' ? 1 : 0;
