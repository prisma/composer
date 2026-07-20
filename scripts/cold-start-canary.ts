#!/usr/bin/env bun
/**
 * Canary for PRO-217 (the Compute ingress closing a first-touch connection
 * while a scale-to-zero service boots) — the Compute sibling of
 * cold-connect-canary.ts, run as the VERIFY step of a deploy-verify-destroy
 * round over examples/streams (the deploy and teardown are the action's; this
 * script only samples).
 *
 * Shape: A fetches B — the deployed `jobs` service appends to the streams
 * service on every POST /jobs, un-retried (no idempotency key). Each sample
 * forces a genuinely fresh streams instance (create a deployment, upload the
 * artifact, start it, promote it to the app's stable endpoint), fires ONE
 * first-touch POST /jobs the instant the promote call succeeds, then reads
 * the deployment's own boot logs to confirm the touch actually raced the
 * boot — not just that a fresh instance existed somewhere.
 *
 * That log check exists because two earlier designs both produced false
 * signals without it:
 *
 * 1. Waiting for the promoted version to report `running` before touching it
 *    (the original design) gives the boot window time to close: `running`
 *    can flip within ~1s of `start`, well before the app itself is listening
 *    (observed boot time end-to-end: ~2-10s depending on how much state the
 *    streams module restores from the object store), so every touch after
 *    that wait lands on an already-warm process. A follow-up that added
 *    three probes at 0/2.5/5s after promote didn't fix this either — it just
 *    added more delay on top of a promote call that had already let the
 *    window close.
 * 2. Stopping the promoted deployment and touching it — a Management API
 *    `/deployments/{id}/stop` looked like a cleaner trigger than promoting a
 *    new version each sample. Verified live and it doesn't work: a stopped
 *    deployment does not revive on the next request. The app's stable
 *    endpoint just 404s (a plain HTML "Not Found", not the PRO-217 close)
 *    and stays down until something explicitly calls `start` again — so
 *    "stop, then touch" cannot trigger a cold start at all; it's a dead end,
 *    not a shortcut.
 *
 * What does work: create a new deployment, start it, and — instead of
 * waiting for `running` — race the promote call itself (retrying immediately
 * on the 409 "not running yet" it returns before the VM is up), then fire the
 * touch the instant promote succeeds. That still doesn't, by itself, prove
 * the touch beat the boot — so every touch's evidence is checked against the
 * deployment's own logs (`/deployments/{id}/logs`, read from the start):
 * spark's `starting bun with entrypoint: bootstrap.js` line marks the boot
 * beginning, and the streams server's own `listening on 0.0.0.0:…` line
 * marks the moment it can answer anything. A touch sent before that
 * `listening` line is a genuine cold-start observation; a touch sent after
 * it landed on an already-up process and carries no information about
 * PRO-217 either way (see cold-start-canary-classify.ts's `ColdStartTouch`
 * for the exact three-way split, and gotchas.md's PRO-217 entry for the run
 * that skipped this check and reported "fixed" from four warm hits).
 *
 * A REQUIRED check: any close → exit 0, bug still present (today's normal);
 * enough touches reaching a genuine cold start AND holding → exit 1, the
 * forcing signal to remove the streams client's IDEMPOTENT_BACKOFF
 * (PRO-219) and this canary; a run that never manages to force a cold start,
 * or one whose log evidence can't place a touch on either side of the boot,
 * or one too small to trust an all-held result from → exit 0 with a CI
 * warning annotation (a broken/inconclusive/underpowered canary run, not a
 * clean bill of health), so a deploy flake never blocks unrelated PRs.
 *
 * Two more defects, found by a second review round on top of the log check
 * above, are fixed here:
 *
 * 3. Sampling back-to-back (as fast as create/upload/start/promote allow)
 *    produced atypically short boots — around 1s end to end — because
 *    consecutive deployments land on some kind of already-warm host
 *    resource; the mechanism isn't established, but the effect is. A manual
 *    probe that instead spaced touches 60s apart against the same stack saw
 *    boots of 3.3s, 10.4s, 11.6s, 12.8s, and 21.9s, and reproduced the close
 *    on 3 of 5 touches. SAMPLE_INTERVAL_MS below reproduces that spacing, and
 *    — per live evidence gathered while building this fix — is applied
 *    before sample #0 too: even with DURABILITY_WAIT_MS already elapsed,
 *    sample #0 landed in the same short, ambiguous window when it fired
 *    right after the deploy step's own start of this service.
 * 4. PRO-217 is intermittent, so a run where every touch happened to hold is
 *    the outcome intermittency predicts most of the time from a small
 *    sample — it is not evidence the bug is gone. `classifyColdStartRun`'s
 *    bug-gone branch now requires a sample size, derived from a target close
 *    rate, that makes an all-held run genuinely improbable if the bug is
 *    still present; see cold-start-canary-classify.ts's
 *    MIN_HELD_SAMPLES_FOR_BUG_GONE for the arithmetic.
 *
 * A third fix, also from that round: the boot-log timestamp comes from the
 * streams server's own clock on the Compute VM, and `touchSentAt` comes from
 * `new Date()` on the CI runner — two different clocks with no guaranteed
 * sync between them. `classifyBootEvidence` in cold-start-canary-classify.ts
 * only calls a touch confirmed-cold or confirmed-warm when it is on the far
 * side of a margin comfortably larger than plausible clock skew; anything
 * closer than that is `unknown`, not a guess. The latency-based fallback
 * this file used to fall back to when the log read failed is gone outright —
 * real samples have been observed running 860-1598ms, straddling any fixed
 * latency threshold, so a latency alone cannot stand in for reading the log.
 */
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import {
  type ColdStartTouch,
  classifyBootEvidence,
  classifyColdStartRun,
  classifyColdStartTouch,
  findListeningTimestamp,
  MIN_HELD_SAMPLES_FOR_BUG_GONE,
} from './cold-start-canary-classify.ts';

const API = 'https://api.prisma.io/v1';
/**
 * MIN_HELD_SAMPLES_FOR_BUG_GONE confirmed cold-start holds are what a
 * bug-gone verdict needs; sampling fewer than that can never produce one
 * (classifyColdStartRun reports inconclusive instead), so that count is the
 * default budget. A close is decisive the moment it happens (see the
 * early-exit in the sampling loop below), so a run against a stack where the
 * bug is present typically finishes in far fewer samples than this.
 */
const SAMPLES = Number(process.env['COLD_START_SAMPLES'] ?? String(MIN_HELD_SAMPLES_FOR_BUG_GONE));
/**
 * The streams module seals segments every 5s and uploads them to the store; a
 * fresh instance bootstraps from what the store holds. Sample too soon after
 * the warmup and the fresh instance restores a world without the canary's
 * stream — every touch 404s (observed on this canary's first live round).
 */
const DURABILITY_WAIT_MS = Number(process.env['COLD_START_DURABILITY_WAIT_MS'] ?? '10000');
/**
 * The gap enforced before every sample, including the first — reproduces the
 * 60s-spaced manual probe that actually lands touches in the long boot
 * window; see fix 3 in the module comment above. This is applied before
 * sample #0 too, on top of DURABILITY_WAIT_MS: live runs during this fix
 * showed sample #0 landing in the same ~1-1.3s ambiguous window that
 * back-to-back sampling produces, even with DURABILITY_WAIT_MS already
 * elapsed, most likely because it follows so soon after the deploy step's
 * own start of this same service. Since any touch this run cannot place on
 * either side of the boot blocks a bug-gone verdict for the whole run (see
 * cold-start-canary-classify.ts), a sample #0 that is reliably ambiguous
 * would make bug-gone unreachable no matter how many samples follow it.
 */
const SAMPLE_INTERVAL_MS = Number(process.env['COLD_START_SAMPLE_INTERVAL_MS'] ?? '60000');
/**
 * How long to read a fresh deployment's boot logs before giving up on
 * finding the `listening` line. Manual probing has observed start→listening
 * as long as 21.9s; this sits comfortably above that so a genuinely slow
 * (but real) boot still gets read to completion rather than timing out into
 * an `unknown` boot-evidence verdict.
 */
const LOG_READ_TIMEOUT_MS = Number(process.env['COLD_START_LOG_READ_TIMEOUT_MS'] ?? '30000');
/**
 * The run's own wall-clock budget. If sampling is still going once this
 * elapses, the loop stops taking new samples and reports whatever it has
 * collected so far instead of running toward the CI job's own
 * timeout-minutes kill: a job killed by that external timeout never reaches
 * classifyColdStartRun at all, so it can't emit the inconclusive exit and
 * warning annotation this script is supposed to use for a run that can't
 * finish — it just shows up as a bare failed step. 20 minutes matches the
 * worst-case budget (MIN_HELD_SAMPLES_FOR_BUG_GONE samples at roughly 85s
 * each: 60s of spacing plus ~25s of create/upload/start/promote/touch/log-
 * read, measured live) with the surrounding job's install/build/deploy/
 * destroy/sweep steps still fitting under its 30-minute timeout.
 */
const MAX_RUN_MS = Number(process.env['COLD_START_MAX_RUN_MS'] ?? '1200000');

const token = process.env['PRISMA_SERVICE_TOKEN'];
const stackName = process.env['STACK_NAME'];
if (!token || !stackName) {
  console.error('PRISMA_SERVICE_TOKEN and STACK_NAME are required');
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ApiResponse {
  readonly status: number;
  readonly data: unknown;
}

/** POSTs/GETs the Management API, returning the status alongside the parsed `data` field — never throws on a non-2xx status. */
async function apiCall(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, data: isRecord(json) ? json['data'] : json };
}

/** Same as apiCall, but throws on a non-2xx status — for calls this script cannot proceed without. */
async function apiData(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await apiCall(method, path, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
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
  const list = Array.isArray(projects) ? projects : [];
  const match = list.find((p) => isRecord(p) && p['name'] === stackName);
  if (match === undefined) throw new Error(`no project named "${stackName}" — did the deploy run?`);
  return requireString(match, 'id');
}

interface Apps {
  readonly jobsUrl: string;
  readonly streamsAppId: string;
}

/** `/v1/apps` is the current Management API surface for what used to be `/v1/compute-services` (same underlying resources, verified live — see gotchas.md's PRO-217 entry). */
async function findApps(projectId: string): Promise<Apps> {
  const apps = await apiData('GET', `/apps?projectId=${projectId}&limit=100`);
  const list = Array.isArray(apps) ? apps : [];
  let jobsUrl: string | undefined;
  let streamsAppId: string | undefined;
  for (const app of list) {
    if (!isRecord(app)) continue;
    if (app['name'] === 'jobs') jobsUrl = requireString(app, 'appEndpointDomain');
    if (app['name'] === 'streams.service') streamsAppId = requireString(app, 'id');
  }
  if (!jobsUrl || !streamsAppId) {
    throw new Error(`stack "${stackName}" is missing the jobs/streams apps`);
  }
  return { jobsUrl, streamsAppId };
}

/**
 * The deploy that just ran left the content-addressed streams artifact in the
 * runner's temp dir (packageComputeArtifact) — reuse it so every promoted
 * deployment is byte-identical to the deployed one.
 */
function findStreamsArtifact(): string {
  const dir = `${os.tmpdir()}/prisma-composer-compute-${os.userInfo().uid}`;
  const found = execSync(`ls -t ${dir}/*/streams.service.tar.gz 2>/dev/null | head -1`, {
    encoding: 'utf8',
  }).trim();
  if (!found) throw new Error(`no streams.service.tar.gz under ${dir} — did the deploy build?`);
  return found;
}

/**
 * Reads a deployment's boot log from the start, stopping as soon as the
 * app's own `listening` line has been seen (or LOG_READ_TIMEOUT_MS elapses,
 * or the socket errors/closes). Returns the concatenated log text collected
 * so far — `findListeningTimestamp` on the result may still be undefined if
 * the line was never seen.
 */
function readDeploymentBootLog(deploymentId: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let settled = false;
    const ws = new WebSocket(
      `wss://api.prisma.io/v1/deployments/${deploymentId}/logs?from_start=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(chunks.join(''));
    };
    const timer = setTimeout(finish, LOG_READ_TIMEOUT_MS);
    ws.addEventListener('message', (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (isRecord(parsed) && parsed['type'] === 'log' && typeof parsed['text'] === 'string') {
        chunks.push(parsed['text']);
        if (findListeningTimestamp(chunks.join('')) !== undefined) finish();
      }
    });
    ws.addEventListener('error', finish);
    ws.addEventListener('close', finish);
  });
}

/**
 * One fresh streams deployment, touched once: create → upload → start → race
 * the promote call (retrying immediately on the "not running yet" 409 — NOT
 * polling for `running` and then promoting, which is what let the boot
 * window close in the original design; see the module doc comment) → fire
 * the touch the instant promote succeeds → confirm from the deployment's own
 * boot log whether the touch actually landed before the app was listening.
 */
async function sampleFreshStart(
  jobsUrl: string,
  streamsAppId: string,
  artifactPath: string,
  index: number,
): Promise<ColdStartTouch> {
  const created = await apiData('POST', `/apps/${streamsAppId}/deployments`, {
    portMapping: { http: 3000 },
  });
  const deploymentId = requireString(created, 'id');
  const uploadUrl = requireString(created, 'uploadUrl');
  const artifact = await Bun.file(artifactPath).arrayBuffer();
  const uploaded = await fetch(uploadUrl, { method: 'PUT', body: artifact });
  if (!uploaded.ok) throw new Error(`artifact upload failed: ${uploaded.status}`);

  await apiData('POST', `/deployments/${deploymentId}/start`);

  const promoteDeadline = Date.now() + 30_000;
  for (;;) {
    const res = await apiCall('POST', `/apps/${streamsAppId}/promote`, { deploymentId });
    if (res.status === 200) break;
    if (res.status !== 409 || Date.now() > promoteDeadline) {
      throw new Error(
        `promote never succeeded for deployment ${deploymentId}: ${res.status} ` +
          JSON.stringify(res.data),
      );
    }
    // A short, deliberate courtesy delay — not a "wait for running" poll.
    // Each retry is still racing to promote at the earliest legal moment;
    // this just keeps a slow boot from hammering the API every few ms.
    await sleep(200);
  }

  const touchSentAt = new Date();
  const started = Date.now();
  const res = await fetch(`${jobsUrl}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'canary', touch: `${index}` }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  const latencyMs = Date.now() - started;

  const logText = await readDeploymentBootLog(deploymentId);
  const listeningAt = findListeningTimestamp(logText);
  const bootEvidence = classifyBootEvidence(touchSentAt, listeningAt);
  const evidence =
    listeningAt !== undefined
      ? `logs: listening ${listeningAt.toISOString()}, touch sent ${touchSentAt.toISOString()} (${bootEvidence})`
      : `no listening line read within ${LOG_READ_TIMEOUT_MS}ms — boot evidence unknown, not guessed`;

  const touch = classifyColdStartTouch(res.status, body, bootEvidence);
  const detail = touch === 'other' ? ` — ${body.slice(0, 160)}` : '';
  console.log(
    `  sample #${index}: ${touch} (${res.status}, ${latencyMs}ms) [${evidence}]${detail}`,
  );
  return touch;
}

const projectId = await findProjectId();
const { jobsUrl, streamsAppId } = await findApps(projectId);
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
    await sleep(5_000);
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
await sleep(DURABILITY_WAIT_MS);

const runStartedAt = Date.now();
const touches: ColdStartTouch[] = [];
for (let i = 0; i < SAMPLES; i++) {
  if (Date.now() - runStartedAt > MAX_RUN_MS) {
    console.log(
      `  stopping after ${i} sample(s): the run's own ${MAX_RUN_MS}ms wall-clock budget is used ` +
        'up — reporting the touches collected so far rather than risking a CI timeout kill.',
    );
    break;
  }
  console.log(`  waiting ${SAMPLE_INTERVAL_MS}ms before sample #${i}…`);
  await sleep(SAMPLE_INTERVAL_MS);
  const touch = await sampleFreshStart(jobsUrl, streamsAppId, artifactPath, i);
  touches.push(touch);
  // A close is decisive on its own (classifyColdStartRun's rule) — the
  // verdict is already bug-present, and running the rest of the budget only
  // spends CI minutes without changing the answer.
  if (touch === 'closed') {
    console.log(
      `  close observed on sample #${i}; bug-present is already decided — skipping the ` +
        `remaining ${SAMPLES - i - 1} samples.`,
    );
    break;
  }
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
