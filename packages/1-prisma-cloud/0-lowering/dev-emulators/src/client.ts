/**
 * Typed loopback clients for both emulator daemons (local-dev spec § 2),
 * resolving the running daemon's port from the registry. Used by the local
 * providers and the extension's `emulators`/`attach`/`teardown`
 * implementations, which never learn an emulator's HTTP API directly.
 */
import * as fs from 'node:fs';
import { CliStructuredError } from '@internal/foundation/errors';
import {
  type DaemonName,
  type DaemonRootOptions,
  defaultRegistryRoot,
  isPidAlive,
  registryFilePath,
} from './daemon.ts';

function notRunningError(name: DaemonName): Error {
  return new Error(
    `the ${name} emulator is not running — \`prisma dev\` starts it via the extension's dev.emulators hook.`,
  );
}

interface RegistryEntry {
  readonly pid: number;
  readonly port: number;
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'port' in value &&
    typeof value.port === 'number'
  );
}

/** Synchronous resolve — reading a small local JSON file needs no await, and every consumer wants a ready-to-use client object, not a promise. */
function resolveBaseUrl(name: DaemonName, opts: DaemonRootOptions): string {
  const registryRoot = opts.registryRoot ?? defaultRegistryRoot();
  const file = registryFilePath(registryRoot, name);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw notRunningError(name);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw notRunningError(name);
  }
  if (!isRegistryEntry(parsed) || !isPidAlive(parsed.pid)) {
    throw notRunningError(name);
  }
  return `http://127.0.0.1:${parsed.port}`;
}

const ADMIN_FETCH_ATTEMPTS = 3;
const ADMIN_FETCH_RETRY_DELAY_MS = 150;

/**
 * `fetch` for the loopback admin calls, retried on transient socket errors:
 * a keep-alive reuse race (the runtime re-uses a pooled connection the
 * daemon's HTTP server just closed idle — surfaces as "fetch failed" /
 * "other side closed") or a briefly overloaded daemon. A short blind retry is
 * safe only for an idempotent call; a call that is not, such as creating an
 * instance, passes `retry: false`, because the emulator may have handled the
 * first attempt. A caller-driven abort is never retried. When every attempt
 * fails to connect, it throws `DEV.EMULATOR_UNREACHABLE`; callers retry that
 * code and nothing else.
 */
async function adminFetch(
  url: string,
  init?: RequestInit,
  opts: { readonly retry?: boolean } = {},
): Promise<Response> {
  const attempts = opts.retry === false ? 1 : ADMIN_FETCH_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (init?.signal?.aborted === true) throw error;
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, ADMIN_FETCH_RETRY_DELAY_MS));
      }
    }
  }
  throw new CliStructuredError(
    'DEV.EMULATOR_UNREACHABLE',
    `Could not connect to the local dev emulator at ${new URL(url).origin}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    {
      why: 'The emulator is registered and its process is alive, but it did not accept the connection.',
      fix: "Run the command again. If it keeps failing, end the emulator's process; the next `prisma dev` starts a new one.",
      meta: { url },
      cause: lastError,
    },
  );
}

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`request to the local dev emulator failed (${res.status}): ${body}`);
  }
  return res;
}

export type ServiceInstanceStatus = 'running' | 'backoff' | 'held' | 'stopped';

export interface ServiceInstanceInfo {
  readonly id: string;
  /** Stored and returned verbatim; the emulator never reads them. */
  readonly labels: Readonly<Record<string, string>>;
  readonly port: number;
  readonly url: string;
  readonly status: ServiceInstanceStatus;
  readonly pid?: number;
  readonly lastExitCode?: number;
  readonly artifactHash?: string;
  readonly logPath: string;
}

export interface CreateServiceRequest {
  readonly labels: Readonly<Record<string, string>>;
  /** Used if no instance holds it and it is bindable; otherwise the emulator gives the lowest free port from 3000. */
  readonly port?: number;
}

export interface DeploymentRequest {
  readonly artifactDir: string;
  readonly artifactHash: string;
  readonly env: Readonly<Record<string, string>>;
}

const INSTANCE_STATUSES = new Set(['running', 'backoff', 'held', 'stopped']);

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function isServiceInstanceInfo(value: unknown): value is ServiceInstanceInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    'port' in value &&
    typeof value.port === 'number' &&
    'url' in value &&
    typeof value.url === 'string' &&
    'status' in value &&
    typeof value.status === 'string' &&
    INSTANCE_STATUSES.has(value.status) &&
    'logPath' in value &&
    typeof value.logPath === 'string'
  );
}

function isServiceInstanceInfoArray(value: unknown): value is ServiceInstanceInfo[] {
  return Array.isArray(value) && value.every(isServiceInstanceInfo);
}

interface HealthBody {
  readonly version: string;
}

function isHealthBody(value: unknown): value is HealthBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string'
  );
}

/** Each compute instance is keyed by an id the emulator generates when it creates the instance. */
export interface ComputeClient {
  readonly baseUrl: string;
  health(): Promise<{ version: string }>;
  /** `POST /instances` — creates a stopped instance holding a port until it is deleted. Never retried: a retry could create a second instance. */
  createInstance(request: CreateServiceRequest): Promise<ServiceInstanceInfo>;
  /** `GET /instances`. */
  listInstances(): Promise<ServiceInstanceInfo[]>;
  /** `GET /instances/<id>`; undefined when the emulator has no such instance. */
  getInstance(id: string): Promise<ServiceInstanceInfo | undefined>;
  /** `PUT /instances/<id>/deployment` — returns once the instance accepts connections on its port. */
  putDeployment(id: string, deployment: DeploymentRequest): Promise<void>;
  /** `GET /instances/<id>/logs?follow=1` — yields decoded text chunks; ends when `signal` aborts or the daemon closes the stream. */
  followLogs(
    id: string,
    signal?: AbortSignal,
    opts?: { readonly tail?: number },
  ): AsyncIterable<string>;
  /** `POST /instances/start` — the session-resume signal; starts each listed instance with a stored deployment that isn't already running. */
  startInstances(ids: readonly string[]): Promise<void>;
  /** `POST /instances/stop`. The instances keep their ports; an unknown id is skipped. */
  stopInstances(ids: readonly string[]): Promise<void>;
  /** `DELETE /instances/<id>` — stops the instance and frees its port. Deleting an unknown id succeeds. */
  deleteInstance(id: string): Promise<void>;
}

function instancePath(baseUrl: string, id: string): string {
  return `${baseUrl}/instances/${encodeURIComponent(id)}`;
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function computeClient(opts: DaemonRootOptions = {}): ComputeClient {
  const baseUrl = resolveBaseUrl('compute', opts);

  return {
    baseUrl,

    async health() {
      const res = await expectOk(await adminFetch(`${baseUrl}/health`));
      const body: unknown = await res.json();
      if (!isHealthBody(body)) {
        throw new Error('malformed /health response from the compute emulator');
      }
      return body;
    },

    async createInstance(request) {
      const res = await expectOk(
        await adminFetch(`${baseUrl}/instances`, postJson(request), { retry: false }),
      );
      const body: unknown = await res.json();
      if (!isServiceInstanceInfo(body)) {
        throw new Error('malformed instance-create response from the compute emulator');
      }
      return body;
    },

    async listInstances() {
      const res = await expectOk(await adminFetch(`${baseUrl}/instances`));
      const body: unknown = await res.json();
      if (!isServiceInstanceInfoArray(body)) {
        throw new Error('malformed instances listing from the compute emulator');
      }
      return body;
    },

    async getInstance(id) {
      const res = await adminFetch(instancePath(baseUrl, id));
      if (res.status === 404) return undefined;
      const body: unknown = await (await expectOk(res)).json();
      if (!isServiceInstanceInfo(body)) {
        throw new Error('malformed instance response from the compute emulator');
      }
      return body;
    },

    async putDeployment(id, deployment) {
      await expectOk(
        await adminFetch(`${instancePath(baseUrl, id)}/deployment`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(deployment),
        }),
      );
    },

    async *followLogs(id, signal, opts) {
      const tail =
        opts?.tail !== undefined ? `&tail=${String(Math.max(0, Math.trunc(opts.tail)))}` : '';
      const url = `${instancePath(baseUrl, id)}/logs?follow=1${tail}`;
      const res = await expectOk(await adminFetch(url, signal ? { signal } : undefined));
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },

    async startInstances(ids) {
      await expectOk(await adminFetch(`${baseUrl}/instances/start`, postJson({ ids })));
    },

    async stopInstances(ids) {
      await expectOk(await adminFetch(`${baseUrl}/instances/stop`, postJson({ ids })));
    },

    async deleteInstance(id) {
      await expectOk(await adminFetch(instancePath(baseUrl, id), { method: 'DELETE' }));
    },
  };
}

export interface BucketInstanceInfo {
  /** Also the bucket's name on the S3 wire. */
  readonly id: string;
  /** Stored and returned verbatim; the emulator never reads them. */
  readonly labels: Readonly<Record<string, string>>;
  /** Where the bucket's objects live, as its creator registered it. */
  readonly dir: string;
}

export interface CreateBucketRequest {
  readonly labels: Readonly<Record<string, string>>;
  readonly dir: string;
}

function isBucketInstanceInfo(value: unknown): value is BucketInstanceInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    'dir' in value &&
    typeof value.dir === 'string'
  );
}

function isBucketInstanceInfoArray(value: unknown): value is BucketInstanceInfo[] {
  return Array.isArray(value) && value.every(isBucketInstanceInfo);
}

/** Each bucket is an instance keyed by an id the emulator generates, which is also its name on the S3 wire at `baseUrl`. */
export interface BucketsClient {
  readonly baseUrl: string;
  health(): Promise<{ version: string }>;
  /** `POST /_pcdev/instances` — creates the bucket and its data root. Never retried: a retry could create a second bucket. */
  createInstance(request: CreateBucketRequest): Promise<BucketInstanceInfo>;
  /** `GET /_pcdev/instances`. */
  listInstances(): Promise<BucketInstanceInfo[]>;
  /** `GET /_pcdev/instances/<id>`; undefined when the emulator has no such instance. */
  getInstance(id: string): Promise<BucketInstanceInfo | undefined>;
  /** `PUT /_pcdev/instances/<id>/credentials` — accepts this key pair for this bucket. A key registered for another bucket is refused. */
  putCredentials(id: string, accessKeyId: string, secretAccessKey: string): Promise<void>;
  /** `DELETE /_pcdev/instances/<id>` — forgets the bucket and its credentials; its objects stay in its data root. Deleting an unknown id succeeds. */
  deleteInstance(id: string): Promise<void>;
}

export function bucketsClient(opts: DaemonRootOptions = {}): BucketsClient {
  const baseUrl = resolveBaseUrl('buckets', opts);
  const adminUrl = `${baseUrl}/_pcdev/instances`;

  return {
    baseUrl,

    async health() {
      const res = await expectOk(await adminFetch(`${baseUrl}/_pcdev/health`));
      const body: unknown = await res.json();
      if (!isHealthBody(body)) {
        throw new Error('malformed /_pcdev/health response from the buckets emulator');
      }
      return body;
    },

    async createInstance(request) {
      const res = await expectOk(await adminFetch(adminUrl, postJson(request), { retry: false }));
      const body: unknown = await res.json();
      if (!isBucketInstanceInfo(body)) {
        throw new Error('malformed instance-create response from the buckets emulator');
      }
      return body;
    },

    async listInstances() {
      const res = await expectOk(await adminFetch(adminUrl));
      const body: unknown = await res.json();
      if (!isBucketInstanceInfoArray(body)) {
        throw new Error('malformed instances listing from the buckets emulator');
      }
      return body;
    },

    async getInstance(id) {
      const res = await adminFetch(instancePath(`${baseUrl}/_pcdev`, id));
      if (res.status === 404) return undefined;
      const body: unknown = await (await expectOk(res)).json();
      if (!isBucketInstanceInfo(body)) {
        throw new Error('malformed instance response from the buckets emulator');
      }
      return body;
    },

    async putCredentials(id, accessKeyId, secretAccessKey) {
      await expectOk(
        await adminFetch(`${instancePath(`${baseUrl}/_pcdev`, id)}/credentials`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accessKeyId, secretAccessKey }),
        }),
      );
    },

    async deleteInstance(id) {
      await expectOk(await adminFetch(instancePath(`${baseUrl}/_pcdev`, id), { method: 'DELETE' }));
    },
  };
}

export interface DatabaseInstanceInfo {
  readonly id: string;
  /** Stored and returned verbatim; the emulator never reads them. */
  readonly labels: Readonly<Record<string, string>>;
  readonly port: number;
  readonly url: string;
  readonly status: 'running' | 'stopped';
}

export interface CreateDatabaseRequest {
  readonly labels: Readonly<Record<string, string>>;
  /** Used if no instance holds it and it is bindable; otherwise the emulator gives the lowest free port in its database range. */
  readonly port?: number;
  /** Where the caller resolved `@prisma/dev`; the emulator loads it from here. */
  readonly prismaDevModulePath: string;
}

function isDatabaseInstanceInfo(value: unknown): value is DatabaseInstanceInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    'port' in value &&
    typeof value.port === 'number' &&
    'url' in value &&
    typeof value.url === 'string' &&
    'status' in value &&
    (value.status === 'running' || value.status === 'stopped')
  );
}

function isDatabaseInstanceInfoArray(value: unknown): value is DatabaseInstanceInfo[] {
  return Array.isArray(value) && value.every(isDatabaseInstanceInfo);
}

/** Each database is an instance keyed by an id the emulator generates, served by its own `@prisma/dev` server. */
export interface PostgresClient {
  readonly baseUrl: string;
  health(): Promise<{ version: string }>;
  /** `POST /instances` — creates a database and starts its server; it holds its port until it is deleted. Never retried: a retry could create a second database. */
  createInstance(request: CreateDatabaseRequest): Promise<DatabaseInstanceInfo>;
  /** `GET /instances`. */
  listInstances(): Promise<DatabaseInstanceInfo[]>;
  /** `GET /instances/<id>`; undefined when the emulator has no such instance. */
  getInstance(id: string): Promise<DatabaseInstanceInfo | undefined>;
  /** `POST /instances/start` — starts each listed database's server on its port, with its data. Fails naming any unknown id. */
  startInstances(ids: readonly string[], prismaDevModulePath: string): Promise<void>;
  /** `POST /instances/stop` — shuts the servers down and keeps their data and ports; an unknown id is skipped. */
  stopInstances(ids: readonly string[]): Promise<void>;
  /** `DELETE /instances/<id>` — stops the server and deletes its data. Deleting an unknown id succeeds. */
  deleteInstance(id: string): Promise<void>;
}

export function postgresClient(opts: DaemonRootOptions = {}): PostgresClient {
  const baseUrl = resolveBaseUrl('postgres', opts);

  return {
    baseUrl,

    async health() {
      const res = await expectOk(await adminFetch(`${baseUrl}/health`));
      const body: unknown = await res.json();
      if (!isHealthBody(body)) {
        throw new Error('malformed /health response from the postgres emulator');
      }
      return body;
    },

    async createInstance(request) {
      const res = await expectOk(
        await adminFetch(`${baseUrl}/instances`, postJson(request), { retry: false }),
      );
      const body: unknown = await res.json();
      if (!isDatabaseInstanceInfo(body)) {
        throw new Error('malformed instance-create response from the postgres emulator');
      }
      return body;
    },

    async listInstances() {
      const res = await expectOk(await adminFetch(`${baseUrl}/instances`));
      const body: unknown = await res.json();
      if (!isDatabaseInstanceInfoArray(body)) {
        throw new Error('malformed instances listing from the postgres emulator');
      }
      return body;
    },

    async getInstance(id) {
      const res = await adminFetch(instancePath(baseUrl, id));
      if (res.status === 404) return undefined;
      const body: unknown = await (await expectOk(res)).json();
      if (!isDatabaseInstanceInfo(body)) {
        throw new Error('malformed instance response from the postgres emulator');
      }
      return body;
    },

    async startInstances(ids, prismaDevModulePath) {
      await expectOk(
        await adminFetch(`${baseUrl}/instances/start`, postJson({ ids, prismaDevModulePath })),
      );
    },

    async stopInstances(ids) {
      await expectOk(await adminFetch(`${baseUrl}/instances/stop`, postJson({ ids })));
    },

    async deleteInstance(id) {
      await expectOk(await adminFetch(instancePath(baseUrl, id), { method: 'DELETE' }));
    },
  };
}
