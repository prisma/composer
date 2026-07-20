#!/usr/bin/env bun
/**
 * Canary for PRO-217 (the Compute ingress closing a first-touch connection
 * while a scale-to-zero service boots) — the service-RPC sibling of
 * cold-start-canary.ts, run as the VERIFY step of a deploy-verify-destroy
 * round over examples/storefront-auth (the deploy and teardown are the
 * action's; this script only samples).
 *
 * Shape: this script IS the caller — a bare, single-attempt `fetch` straight
 * at `auth.service`'s own `POST /rpc/verify` endpoint, carrying a manually
 * minted `Idempotency-Key` header. It deliberately does NOT go through
 * `makeClient` (`@prisma/composer/service-rpc`) or any framework client:
 * this slice just gave every framework RPC edge a bounded, automatic retry
 * over the same idempotency key (packages/0-framework/2-authoring/service-rpc),
 * so a probe built on that client would have PRO-217's raw first-touch
 * behavior masked by the very retry this slice ships — the platform's actual
 * behavior has to stay observable, not smoothed over by the client under
 * test. Each sample forces a genuinely fresh `auth.service` instance (create
 * a deployment, upload the artifact already built by this job's Deploy step,
 * start it, promote it to the app's stable endpoint), fires ONE first-touch
 * `POST /rpc/verify` the instant the promote call succeeds, then reads the
 * deployment's own boot logs to confirm the touch actually raced the boot —
 * not just that a fresh instance existed somewhere.
 *
 * This inherits cold-start-canary.ts's contract wholesale — the same 2026-
 * 07-17 rebuild that fixed two ways the original streams canary reported
 * "fixed" while PRO-217 was live: it never actually hit a cold start (it
 * waited for `running` before touching, which flips ~1s after `start`, long
 * before the app is listening), and its verdict rule treated "every touch
 * happened to hold" as proof of absence for an intermittent bug. Read that
 * file's own module comment for the full two-defect history; the fixes are
 * the same fixes here:
 *
 * 1. Race the promote call itself (retrying immediately on its 409 "not
 *    running yet") instead of polling for `running` — see `sampleFreshStart`
 *    below.
 * 2. Space samples at least SAMPLE_INTERVAL_MS apart, including before
 *    sample #0 — back-to-back promotions land on some kind of already-warm
 *    host resource and produce atypically short boots the close does not
 *    appear in (cold-start-canary.ts's module comment; gotchas.md's PRO-217
 *    entry has the measured boot times).
 * 3. Prove coldness from the deployment's own boot log
 *    (`/v1/deployments/{id}/logs?from_start=true`), margin-aware against
 *    cross-clock skew, rather than inferring it from latency — see
 *    rpc-cold-start-canary-classify.ts's `classifyBootEvidence`.
 * 4. Require MIN_HELD_SAMPLES_FOR_BUG_GONE confirmed cold-start holds before
 *    a bug-gone verdict, since an intermittent bug's expected outcome from a
 *    too-small sample is "every touch happened to hold" even while the bug
 *    is fully present.
 *
 * What's different from the streams face, beyond the raw-fetch requirement
 * above:
 *
 * - This canary has no "caller" to warm. cold-start-canary.ts warms the
 *   `jobs` service first so a cold `jobs` can't be mistaken for a cold
 *   `streams`; here, THIS SCRIPT is the caller (an ephemeral fetch from the
 *   CI runner, not a Compute service with its own cold start), so there is
 *   nothing upstream of the touch that needs warming.
 * - No durability wait. The streams canary waits for a just-created stream
 *   to reach the object store before sampling, because a fresh streams
 *   instance restores its local state from there. `auth.service` keeps no
 *   local state to restore — its `verify` handler pings Postgres fresh on
 *   every call — so there is nothing to wait for between promoting and
 *   sampling beyond the inherited SAMPLE_INTERVAL_MS spacing itself.
 * - No Authorization header. `auth.service` is wired to exactly one RPC
 *   consumer (`storefront`, via `deps: { auth: rpc(authContract) }` in
 *   examples/storefront-auth/modules/storefront/src/service.ts), so per
 *   ADR-0030/0031 it does enforce a per-edge bearer key. This script cannot
 *   obtain that key: it is minted once at deploy time and, per the
 *   Management API's own contract for environment variables, "is stored
 *   encrypted and is not returned by subsequent reads" — verified live
 *   against a real deploy, where an unauthenticated touch against a warm
 *   `auth.service` got back exactly `401 {"error":"Unauthorized: missing or
 *   invalid service key"}`. Sending no Authorization header (never a guessed
 *   one) is the honest choice, and rpc-cold-start-canary-classify.ts treats
 *   that specific, known 401 the same as a real success for classification
 *   purposes — see its module comment for why that is still sound evidence
 *   for PRO-217 specifically (the accepted-key check runs only after the
 *   ingress has already carried the connection through).
 * - No listening-line source in the example as written. Unlike
 *   @prisma/streams-server, `auth.service`'s own server.ts never logged
 *   anything on boot, so cold-start-canary.ts's technique had nothing to
 *   read. examples/storefront-auth/modules/auth/src/server.ts now logs one
 *   self-timestamped line right after `Bun.serve()` returns (see that
 *   file's comment) — Compute's log relay passes plain app stdout through
 *   completely unmodified (verified live: no platform-added timestamp), so
 *   the timestamp has to come from the app's own clock, the same as
 *   streams-server's console.log patch does for the streams face.
 *
 * A REQUIRED check: any close → exit 0, bug still present (today's normal);
 * enough touches reaching a genuine cold start AND holding → exit 1, the
 * signal to retire this canary (never the Idempotency-Key protocol or the
 * bounded retry — those are permanent protocol semantics for this kind, not
 * a PRO-217 compensation); a run that never manages to force a cold start,
 * or one whose log evidence can't place a touch on either side of the boot,
 * or one too small to trust an all-held result from → exit 0 with a CI
 * warning annotation.
 */
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import {
  classifyBootEvidence,
  classifyRpcColdStartRun,
  classifyRpcColdStartTouch,
  findListeningTimestamp,
  MIN_HELD_SAMPLES_FOR_BUG_GONE,
  type RpcColdStartTouch,
} from './rpc-cold-start-canary-classify.ts';

const API = 'https://api.prisma.io/v1';
/**
 * MIN_HELD_SAMPLES_FOR_BUG_GONE confirmed cold-start holds are what a
 * bug-gone verdict needs; sampling fewer than that can never produce one
 * (classifyRpcColdStartRun reports inconclusive instead), so that count is
 * the default budget. A close is decisive the moment it happens (see the
 * early-exit in the sampling loop below), so a run against a stack where the
 * bug is present typically finishes in far fewer samples than this.
 */
const SAMPLES = Number(
  process.env['RPC_COLD_START_SAMPLES'] ?? String(MIN_HELD_SAMPLES_FOR_BUG_GONE),
);
/**
 * The gap enforced before every sample, including the first — reproduces
 * cold-start-canary.ts's SAMPLE_INTERVAL_MS spacing and its reasoning:
 * back-to-back promotions land on some kind of already-warm host resource
 * and produce atypically short boots the close does not appear in. Unlike
 * the streams face, there is no separate durability wait stacked on top of
 * this — auth.service restores no local state, so this is the only spacing
 * a sample needs.
 */
const SAMPLE_INTERVAL_MS = Number(process.env['RPC_COLD_START_SAMPLE_INTERVAL_MS'] ?? '60000');
/**
 * How long to read a fresh deployment's boot logs before giving up on
 * finding the `listening` line. Matches cold-start-canary.ts's
 * LOG_READ_TIMEOUT_MS — manual probing of this same platform behavior has
 * observed start->listening as long as 21.9s, so this sits comfortably above
 * that.
 */
const LOG_READ_TIMEOUT_MS = Number(process.env['RPC_COLD_START_LOG_READ_TIMEOUT_MS'] ?? '30000');
/**
 * The run's own wall-clock budget — see cold-start-canary.ts's identical
 * MAX_RUN_MS for the full reasoning (a job killed by the surrounding CI
 * timeout never reaches classifyRpcColdStartRun, so it can't emit the
 * inconclusive exit and warning annotation this script is supposed to use
 * for a run that can't finish). This canary has no per-sample durability
 * wait to budget for, so its worst case (MIN_HELD_SAMPLES_FOR_BUG_GONE
 * samples at roughly SAMPLE_INTERVAL_MS plus a boot-and-touch each) fits
 * comfortably inside the same 20-minute figure.
 */
const MAX_RUN_MS = Number(process.env['RPC_COLD_START_MAX_RUN_MS'] ?? '1200000');
/** The HTTP port `auth.service` was deployed on — matches its compute() default (no explicit `port` param). */
const AUTH_SERVICE_PORT = 3000;

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

/**
 * `auth.service`'s app id and its own base URL — the touch target.
 * `/v1/apps` is the current Management API surface for what used to be
 * `/v1/compute-services` (verified live — see cold-start-canary.ts's
 * findApps and gotchas.md's PRO-217 entry).
 */
async function findAuthApp(projectId: string): Promise<{ authAppId: string; authUrl: string }> {
  const apps = await apiData('GET', `/apps?projectId=${projectId}&limit=100`);
  const list = Array.isArray(apps) ? apps : [];
  for (const app of list) {
    if (isRecord(app) && app['name'] === 'auth.service') {
      return {
        authAppId: requireString(app, 'id'),
        authUrl: requireString(app, 'appEndpointDomain'),
      };
    }
  }
  throw new Error(`stack "${stackName}" is missing the "auth.service" app`);
}

/**
 * The Deploy step that ran earlier in this job left the content-addressed
 * `auth.service` artifact in the runner's temp dir (packageComputeArtifact)
 * — reuse it so every promoted deployment is byte-identical to the deployed
 * one. Mirrors cold-start-canary.ts's findStreamsArtifact.
 */
function findAuthArtifact(): string {
  const dir = `${os.tmpdir()}/prisma-composer-compute-${os.userInfo().uid}`;
  const found = execSync(`ls -t ${dir}/*/auth.service.tar.gz 2>/dev/null | head -1`, {
    encoding: 'utf8',
  }).trim();
  if (!found) throw new Error(`no auth.service.tar.gz under ${dir} — did the deploy build?`);
  return found;
}

/**
 * Reads a deployment's boot log from the start, stopping as soon as
 * `auth.service`'s own `listening` line has been seen (or
 * LOG_READ_TIMEOUT_MS elapses, or the socket errors/closes). Returns the
 * concatenated log text collected so far — `findListeningTimestamp` on the
 * result may still be undefined if the line was never seen. Identical
 * mechanism to cold-start-canary.ts's readDeploymentBootLog.
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

/** `err`'s message, plus its `cause` chain if it has one — a thrown fetch rejection's `cause` is where Bun puts the underlying socket error. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const causeText = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
  return `${err.message}${causeText}`;
}

/**
 * One fresh `auth.service` deployment, touched once: create -> upload ->
 * start -> race the promote call (retrying immediately on the "not running
 * yet" 409 — NOT polling for `running` and then promoting, which is what let
 * the boot window close in cold-start-canary.ts's original design; see this
 * file's module comment) -> fire ONE bare `POST /rpc/verify` the instant
 * promote succeeds -> confirm from the deployment's own boot log whether the
 * touch actually landed before the app was listening.
 */
async function sampleFreshStart(
  authAppId: string,
  authUrl: string,
  artifactPath: string,
  index: number,
): Promise<RpcColdStartTouch> {
  const created = await apiData('POST', `/apps/${authAppId}/deployments`, {
    portMapping: { http: AUTH_SERVICE_PORT },
  });
  const deploymentId = requireString(created, 'id');
  const uploadUrl = requireString(created, 'uploadUrl');
  const artifact = await Bun.file(artifactPath).arrayBuffer();
  const uploaded = await fetch(uploadUrl, { method: 'PUT', body: artifact });
  if (!uploaded.ok) throw new Error(`artifact upload failed: ${uploaded.status}`);

  await apiData('POST', `/deployments/${deploymentId}/start`);

  const promoteDeadline = Date.now() + 30_000;
  for (;;) {
    const res = await apiCall('POST', `/apps/${authAppId}/promote`, { deploymentId });
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
  let status = 0;
  let body = '';
  let wasThrown = false;
  try {
    const res = await fetch(`${authUrl}/rpc/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ token: `rpc-cold-start-canary-${index}` }),
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    body = await res.text();
  } catch (err) {
    wasThrown = true;
    body = errorText(err);
  }
  const latencyMs = Date.now() - started;

  const logText = await readDeploymentBootLog(deploymentId);
  const listeningAt = findListeningTimestamp(logText);
  const bootEvidence = classifyBootEvidence(touchSentAt, listeningAt);
  const evidence =
    listeningAt !== undefined
      ? `logs: listening ${listeningAt.toISOString()}, touch sent ${touchSentAt.toISOString()} (${bootEvidence})`
      : `no listening line read within ${LOG_READ_TIMEOUT_MS}ms — boot evidence unknown, not guessed`;

  const touch = classifyRpcColdStartTouch(status, body, wasThrown, bootEvidence);
  const statusLabel = wasThrown ? 'thrown' : String(status);
  console.log(
    `  sample #${index}: ${touch} (${statusLabel}, ${latencyMs}ms) [${evidence}] — ${body.slice(0, 160)}`,
  );
  return touch;
}

const projectId = await findProjectId();
const { authAppId, authUrl } = await findAuthApp(projectId);
const artifactPath = findAuthArtifact();
console.log(`Stack "${stackName}" (${projectId}); auth.service at ${authUrl}`);
console.log(`Sampling ${SAMPLES} fresh auth.service instances, ${SAMPLE_INTERVAL_MS}ms apart…`);

const runStartedAt = Date.now();
const touches: RpcColdStartTouch[] = [];
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
  const touch = await sampleFreshStart(authAppId, authUrl, artifactPath, i);
  touches.push(touch);
  // A close is decisive on its own (classifyRpcColdStartRun's rule) — the
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

const result = classifyRpcColdStartRun(touches);
console.log(result.message);
if (result.verdict === 'inconclusive') {
  // A GitHub Actions warning annotation: loud on the run page without
  // failing a required check over a deploy flake. Newlines must be %0A.
  const detail = touches.map((touch, i) => `sample #${i}: ${touch}`).join('; ');
  console.log(
    `::warning title=RPC cold-start canary (PRO-217) inconclusive::${result.message} [${detail}]`,
  );
}
process.exitCode = result.verdict === 'bug-gone' ? 1 : 0;
