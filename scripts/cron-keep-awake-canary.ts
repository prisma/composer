/**
 * Proves the cron scheduler stays awake on Prisma Compute. Runs after
 * examples/cron is deployed (the deploy-verify-destroy action's verify step):
 * sends the stack no traffic for WAIT_MS, then reads the runner's deployment
 * log and checks that jobs kept firing for the whole wait. The scheduler
 * holds Compute's keep-awake guard (@prisma/compute KeepAwakeGuard) for its
 * lifetime; without it the platform idles the scheduler out and its timers
 * stop, which is exactly what this run would then report.
 *
 * Pass: at least MIN_HEARTBEATS `heartbeat` firings (every 5m) and a `tick`
 * firing within TICK_FRESHNESS_MS of the end of the wait.
 */
const API = 'https://api.prisma.io/v1';
const WAIT_MS = Number(process.env['CRON_CANARY_WAIT_MS'] ?? '840000');
const MIN_HEARTBEATS = Number(process.env['CRON_CANARY_MIN_HEARTBEATS'] ?? '2');
const TICK_FRESHNESS_MS = 90_000;
const LOG_QUIET_MS = 5_000;
const LOG_READ_TIMEOUT_MS = 60_000;

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

async function apiData(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  const json: unknown = text ? JSON.parse(text) : undefined;
  return isRecord(json) ? json['data'] : json;
}

function requireString(record: unknown, key: string): string {
  if (!isRecord(record) || typeof record[key] !== 'string') {
    throw new Error(`expected "${key}" to be a string`);
  }
  return record[key];
}

async function findProjectId(): Promise<string> {
  const projects = await apiData('/projects?limit=100');
  const list = Array.isArray(projects) ? projects : [];
  const match = list.find((p) => isRecord(p) && p['name'] === stackName);
  if (match === undefined) throw new Error(`no project named "${stackName}" — did the deploy run?`);
  return requireString(match, 'id');
}

async function findRunnerDeploymentId(projectId: string): Promise<string> {
  const apps = await apiData(`/apps?projectId=${projectId}&limit=100`);
  const list = Array.isArray(apps) ? apps : [];
  const runner = list.find((app) => isRecord(app) && app['name'] === 'cron.runner');
  if (runner === undefined) throw new Error(`stack "${stackName}" has no cron.runner app`);
  return requireString(runner, 'latestDeploymentId');
}

/** Reads the deployment's log from the start until it goes quiet for LOG_QUIET_MS. */
function readDeploymentLog(deploymentId: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let settled = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const ws = new WebSocket(
      `wss://api.prisma.io/v1/deployments/${deploymentId}/logs?from_start=true`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quiet !== undefined) clearTimeout(quiet);
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
        if (quiet !== undefined) clearTimeout(quiet);
        quiet = setTimeout(finish, LOG_QUIET_MS);
      }
    });
    ws.addEventListener('error', finish);
    ws.addEventListener('close', finish);
  });
}

interface Firing {
  readonly jobId: string;
  readonly at: number;
}

function parseFirings(log: string): Firing[] {
  const firings: Firing[] = [];
  for (const match of log.matchAll(/cron fired (\S+) at (\S+)/g)) {
    const at = Date.parse(match[2] ?? '');
    if (match[1] !== undefined && !Number.isNaN(at)) firings.push({ jobId: match[1], at });
  }
  return firings;
}

const projectId = await findProjectId();
const deploymentId = await findRunnerDeploymentId(projectId);
console.log(
  `runner deployment ${deploymentId}; waiting ${WAIT_MS / 60_000} minutes with no traffic…`,
);
await sleep(WAIT_MS);
const waitedUntil = Date.now();

const log = await readDeploymentLog(deploymentId);
const firings = parseFirings(log);
const heartbeats = firings.filter((f) => f.jobId === 'heartbeat');
const lastTick = firings
  .filter((f) => f.jobId === 'tick')
  .reduce((max, f) => Math.max(max, f.at), 0);
const tickAgeMs = waitedUntil - lastTick;

console.log(
  `${firings.length} firings read; ${heartbeats.length} heartbeat(s) at ${heartbeats
    .map((f) => new Date(f.at).toISOString())
    .join(
      ', ',
    )}; last tick ${lastTick === 0 ? 'never' : `${Math.round(tickAgeMs / 1000)}s before the wait ended`}`,
);

const failures: string[] = [];
if (heartbeats.length < MIN_HEARTBEATS) {
  failures.push(`expected at least ${MIN_HEARTBEATS} heartbeat firings, saw ${heartbeats.length}`);
}
if (lastTick === 0 || tickAgeMs > TICK_FRESHNESS_MS) {
  failures.push(`expected a tick within ${TICK_FRESHNESS_MS / 1000}s of the end of the wait`);
}
if (failures.length > 0) {
  console.error(
    `cron keep-awake canary FAILED: the scheduler stopped firing.\n- ${failures.join('\n- ')}`,
  );
  process.exit(1);
}
console.log('cron keep-awake canary passed: the scheduler kept firing through the idle window.');

export {};
