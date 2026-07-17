#!/usr/bin/env bun
/**
 * Canary for PRO-217 (the Compute ingress closing a first-touch connection
 * while a scale-to-zero service boots) — the Compute sibling of
 * cold-connect-canary.ts, run as the VERIFY step of a deploy-verify-destroy
 * round over examples/streams (the deploy and teardown are the action's; this
 * script only samples).
 *
 * Shape: A fetches B — the deployed `jobs` service appends to the streams
 * service on every POST /jobs, un-retried (no idempotency key). Idling is an
 * unreliable trigger (see the gotcha entry), so each sample forces a FRESH
 * streams instance by promoting a new version of the same artifact, then
 * fires ONE first-touch POST /jobs and reads what the caller saw: 201 means
 * the edge held the connection through the boot; a 502 naming a socket close
 * is PRO-217.
 *
 * A REQUIRED check (see cold-start-canary-classify.ts): any close → exit 0,
 * bug still present (today's normal); ALL held → exit 1, the forcing signal
 * to remove createStreamsClient's IDEMPOTENT_BACKOFF (PRO-219) and this
 * canary; anything inconclusive → exit 0 with a CI warning annotation, so a
 * deploy flake never blocks unrelated PRs.
 */
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import {
  type ColdStartTouch,
  classifyColdStartRun,
  classifyColdStartTouch,
} from './cold-start-canary-classify.ts';

const API = 'https://api.prisma.io/v1';
const SAMPLES = Number(process.env['COLD_START_SAMPLES'] ?? '4');
/**
 * The streams module seals segments every 5s and uploads them to the store; a
 * fresh instance bootstraps from what the store holds. Sample too soon after
 * the warmup and the fresh instance restores a world without the canary's
 * stream — every touch 404s (observed on this canary's first live round).
 */
const DURABILITY_WAIT_MS = Number(process.env['COLD_START_DURABILITY_WAIT_MS'] ?? '10000');

const token = process.env['PRISMA_SERVICE_TOKEN'];
const stackName = process.env['STACK_NAME'];
if (!token || !stackName) {
  console.error('PRISMA_SERVICE_TOKEN and STACK_NAME are required');
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function apiData(method: string, path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  const json: unknown = await res.json();
  return isRecord(json) ? json['data'] : undefined;
}

function requireString(record: unknown, key: string): string {
  if (!isRecord(record) || typeof record[key] !== 'string') {
    throw new Error(`expected "${key}" to be a string`);
  }
  return record[key];
}

/** The per-run project shares the stack's name (`prisma-composer deploy --name`). */
async function findProjectId(): Promise<string> {
  const projects = await apiData('GET', '/projects?limit=100');
  if (!isRecord(projects) && !Array.isArray(projects)) throw new Error('unexpected projects body');
  const list = Array.isArray(projects) ? projects : [];
  const match = list.find((p) => isRecord(p) && p['name'] === stackName);
  if (match === undefined) throw new Error(`no project named "${stackName}" — did the deploy run?`);
  return requireString(match, 'id');
}

interface Services {
  readonly jobsUrl: string;
  readonly streamsServiceId: string;
}

async function findServices(projectId: string): Promise<Services> {
  const services = await apiData('GET', `/projects/${projectId}/compute-services`);
  const list = Array.isArray(services) ? services : [];
  let jobsUrl: string | undefined;
  let streamsServiceId: string | undefined;
  for (const svc of list) {
    if (!isRecord(svc)) continue;
    if (svc['name'] === 'jobs') jobsUrl = requireString(svc, 'serviceEndpointDomain');
    if (svc['name'] === 'streams.service') streamsServiceId = requireString(svc, 'id');
  }
  if (!jobsUrl || !streamsServiceId) {
    throw new Error(`stack "${stackName}" is missing the jobs/streams services`);
  }
  return { jobsUrl, streamsServiceId };
}

/**
 * The deploy that just ran left the content-addressed streams artifact in the
 * runner's temp dir (packageComputeArtifact) — reuse it so every promoted
 * version is byte-identical to the deployed one.
 */
function findStreamsArtifact(): string {
  const dir = `${os.tmpdir()}/prisma-composer-compute-${os.userInfo().uid}`;
  const found = execSync(`ls -t ${dir}/*/streams.service.tar.gz 2>/dev/null | head -1`, {
    encoding: 'utf8',
  }).trim();
  if (!found) throw new Error(`no streams.service.tar.gz under ${dir} — did the deploy build?`);
  return found;
}

/** create → upload → start → wait-running → promote: one genuinely fresh, cold instance. */
async function promoteFreshInstance(serviceId: string, artifactPath: string): Promise<void> {
  const created = await apiData('POST', `/compute-services/${serviceId}/versions`, {
    portMapping: { http: 3000 },
  });
  const versionId = requireString(created, 'id');
  const uploadUrl = requireString(created, 'uploadUrl');
  const artifact = await Bun.file(artifactPath).arrayBuffer();
  const uploaded = await fetch(uploadUrl, { method: 'PUT', body: artifact });
  if (!uploaded.ok) throw new Error(`artifact upload failed: ${uploaded.status}`);
  await apiData('POST', `/compute-services/versions/${versionId}/start`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const version = await apiData('GET', `/compute-services/versions/${versionId}`);
    if (isRecord(version) && version['status'] === 'running') break;
    if (Date.now() > deadline) throw new Error(`version ${versionId} never reached running`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await apiData('POST', `/compute-services/${serviceId}/promote`, { versionId });
}

/**
 * One fresh start's touches: the un-retried append path, probed across the
 * switchover window (immediately after promote, then twice more a few seconds
 * apart) — routing to the new instance is not instant, so a single immediate
 * touch can land on the OLD, warm instance and read as a hold it never earned.
 * A sample is `closed` if ANY probe saw the close, `held` only if every probe
 * succeeded.
 */
const PROBE_DELAYS_MS = [0, 2_500, 5_000];

async function sampleFreshStart(jobsUrl: string, index: number): Promise<ColdStartTouch> {
  const probes: ColdStartTouch[] = [];
  for (const [i, delay] of PROBE_DELAYS_MS.entries()) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const started = Date.now();
    const res = await fetch(`${jobsUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'canary', touch: `${index}.${i}` }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    const probe = classifyColdStartTouch(res.status, body);
    const detail = probe === 'held' ? '' : ` — ${body.slice(0, 120)}`;
    console.log(
      `  sample #${index} probe ${i}: ${probe} (${res.status}, ${Date.now() - started}ms)${detail}`,
    );
    probes.push(probe);
  }
  if (probes.includes('closed')) return 'closed';
  if (probes.every((probe) => probe === 'held')) return 'held';
  return 'other';
}

const projectId = await findProjectId();
const { jobsUrl, streamsServiceId } = await findServices(projectId);
const artifactPath = findStreamsArtifact();
console.log(`Stack "${stackName}" (${projectId}); jobs at ${jobsUrl}`);

// Warm the CALLER and create the stream, so every sample's failure can only
// come from the fresh streams instance — not from jobs' own cold start or the
// retried (idempotent) create path. A few attempts: the very first CI touch
// can meet BOTH services cold at once, which is not what this canary samples.
let warmed = false;
for (let attempt = 1; attempt <= 3 && !warmed; attempt++) {
  const warm = await fetch(`${jobsUrl}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'canary', touch: `warmup-${attempt}` }),
    signal: AbortSignal.timeout(90_000),
  });
  if (warm.status === 201) warmed = true;
  else {
    console.error(
      `  warmup attempt ${attempt}: ${warm.status} ${(await warm.text()).slice(0, 160)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
if (!warmed) {
  console.error('warmup never succeeded — the stack is unhealthy; not a PRO-217 verdict.');
  process.exit(1);
}
console.log(
  `Warmed up; waiting ${DURABILITY_WAIT_MS}ms for the stream to reach the store, ` +
    `then sampling ${SAMPLES} fresh streams instances…`,
);
await new Promise((resolve) => setTimeout(resolve, DURABILITY_WAIT_MS));

const touches: ColdStartTouch[] = [];
for (let i = 0; i < SAMPLES; i++) {
  await promoteFreshInstance(streamsServiceId, artifactPath);
  touches.push(await sampleFreshStart(jobsUrl, i));
}

const result = classifyColdStartRun(touches);
console.log(result.message);
if (result.verdict === 'inconclusive') {
  // A GitHub Actions warning annotation: loud on the run page without
  // failing a required check over a deploy flake. Newlines must be %0A.
  const detail = touches.map((touch, i) => `sample #${i}: ${touch}`).join('; ');
  console.log(
    `::warning title=Cold-start canary (PRO-217) inconclusive::${result.message} [${detail}]`,
  );
}
process.exitCode = result.verdict === 'bug-gone' ? 1 : 0;
