/**
 * Typed loopback clients for both emulator daemons (local-dev spec § 2),
 * resolving the running daemon's port from the registry. Used by the local
 * providers and the extension's `emulators`/`attach`/`teardown`
 * implementations, which never learn an emulator's HTTP API directly.
 */
import * as fs from 'node:fs';
import {
  type DaemonName,
  type DaemonRootOptions,
  defaultRegistryRoot,
  isPidAlive,
  registryFilePath,
} from './daemon.ts';
import { isValidSegment } from './segments.ts';

function notRunningError(name: DaemonName): Error {
  return new Error(
    `the ${name} emulator is not running — \`prisma-composer dev\` starts it via the extension's dev.emulators hook.`,
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

function encodeSegment(segment: string): string {
  if (!isValidSegment(segment)) {
    throw new Error(`invalid path segment "${segment}"`);
  }
  return encodeURIComponent(segment);
}

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`request to the local dev emulator failed (${res.status}): ${body}`);
  }
  return res;
}

export interface ServiceInfo {
  readonly id: string;
  readonly address: string;
  readonly port: number;
  readonly url: string;
  readonly status: 'running' | 'backoff' | 'held' | 'stopped';
  readonly pid?: number;
  readonly lastExitCode?: number;
  readonly artifactHash?: string;
  readonly logPath: string;
}

export interface DeploymentRequest {
  readonly address: string;
  readonly artifactDir: string;
  readonly artifactHash: string;
  readonly env: Readonly<Record<string, string>>;
  readonly port: number;
}

const SERVICE_STATUSES = new Set(['running', 'backoff', 'held', 'stopped']);

function isServiceInfo(value: unknown): value is ServiceInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'address' in value &&
    typeof value.address === 'string' &&
    'port' in value &&
    typeof value.port === 'number' &&
    'url' in value &&
    typeof value.url === 'string' &&
    'status' in value &&
    typeof value.status === 'string' &&
    SERVICE_STATUSES.has(value.status) &&
    'logPath' in value &&
    typeof value.logPath === 'string'
  );
}

function isServiceInfoArray(value: unknown): value is ServiceInfo[] {
  return Array.isArray(value) && value.every(isServiceInfo);
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

interface ServiceReservation {
  readonly port: number;
  readonly url: string;
}

function isServiceReservation(value: unknown): value is ServiceReservation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'port' in value &&
    typeof value.port === 'number' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}

export interface ComputeClient {
  readonly baseUrl: string;
  health(): Promise<{ version: string }>;
  /** `PUT /apps/<app>/services/<id>` — reserves (or returns) the service's stable port. Idempotent. */
  ensureService(app: string, id: string): Promise<{ port: number; url: string }>;
  /** `PUT /apps/<app>/services/<id>/deployment`. */
  putDeployment(app: string, id: string, deployment: DeploymentRequest): Promise<void>;
  /** `GET /apps/<app>/services`. */
  listServices(app: string): Promise<ServiceInfo[]>;
  /** `GET /apps/<app>/services/<id>/logs?follow=1` — yields decoded text chunks; ends when `signal` aborts or the daemon closes the stream. */
  followLogs(app: string, id: string, signal?: AbortSignal): AsyncIterable<string>;
  /** `POST /apps/<app>/stop`. */
  stopApp(app: string): Promise<void>;
  /** `POST /apps/<app>/start` — the session-resume signal; starts every service with a stored deployment that isn't already running. */
  startApp(app: string): Promise<void>;
  /** `DELETE /apps/<app>`. */
  deleteApp(app: string): Promise<void>;
}

export function computeClient(opts: DaemonRootOptions = {}): ComputeClient {
  const baseUrl = resolveBaseUrl('compute', opts);

  return {
    baseUrl,

    async health() {
      const res = await expectOk(await fetch(`${baseUrl}/health`));
      const body: unknown = await res.json();
      if (!isHealthBody(body)) {
        throw new Error('malformed /health response from the compute emulator');
      }
      return body;
    },

    async ensureService(app, id) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/services/${encodeSegment(id)}`;
      const res = await expectOk(await fetch(url, { method: 'PUT' }));
      const body: unknown = await res.json();
      if (!isServiceReservation(body)) {
        throw new Error('malformed service-reservation response from the compute emulator');
      }
      return body;
    },

    async putDeployment(app, id, deployment) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/services/${encodeSegment(id)}/deployment`;
      await expectOk(
        await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(deployment),
        }),
      );
    },

    async listServices(app) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/services`;
      const res = await expectOk(await fetch(url));
      const body: unknown = await res.json();
      if (!isServiceInfoArray(body)) {
        throw new Error('malformed services listing from the compute emulator');
      }
      return body;
    },

    async *followLogs(app, id, signal) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/services/${encodeSegment(id)}/logs?follow=1`;
      const res = await expectOk(await fetch(url, signal ? { signal } : undefined));
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

    async stopApp(app) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/stop`;
      await expectOk(await fetch(url, { method: 'POST' }));
    },

    async startApp(app) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/start`;
      await expectOk(await fetch(url, { method: 'POST' }));
    },

    async deleteApp(app) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}`;
      await expectOk(await fetch(url, { method: 'DELETE' }));
    },
  };
}

export interface BucketsClient {
  readonly baseUrl: string;
  health(): Promise<{ version: string }>;
  /** `PUT /_pcdev/apps/<app>/buckets/<name>`. */
  putBucket(app: string, name: string, dir: string): Promise<void>;
  /** `PUT /_pcdev/apps/<app>/credentials`. */
  putCredentials(app: string, accessKeyId: string, secretAccessKey: string): Promise<void>;
  /** `DELETE /_pcdev/apps/<app>`. */
  deleteApp(app: string): Promise<void>;
}

export function bucketsClient(opts: DaemonRootOptions = {}): BucketsClient {
  const baseUrl = resolveBaseUrl('buckets', opts);

  return {
    baseUrl,

    async health() {
      const res = await expectOk(await fetch(`${baseUrl}/_pcdev/health`));
      const body: unknown = await res.json();
      if (!isHealthBody(body)) {
        throw new Error('malformed /_pcdev/health response from the buckets emulator');
      }
      return body;
    },

    async putBucket(app, name, dir) {
      const url = `${baseUrl}/_pcdev/apps/${encodeSegment(app)}/buckets/${encodeSegment(name)}`;
      await expectOk(
        await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir }),
        }),
      );
    },

    async putCredentials(app, accessKeyId, secretAccessKey) {
      const url = `${baseUrl}/_pcdev/apps/${encodeSegment(app)}/credentials`;
      await expectOk(
        await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accessKeyId, secretAccessKey }),
        }),
      );
    },

    async deleteApp(app) {
      const url = `${baseUrl}/_pcdev/apps/${encodeSegment(app)}`;
      await expectOk(await fetch(url, { method: 'DELETE' }));
    },
  };
}

export interface DatabaseInfo {
  readonly id: string;
  readonly url: string;
  readonly instanceName: string;
  readonly databasePort: number;
}

function isDatabaseInfo(value: unknown): value is DatabaseInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'url' in value &&
    typeof value.url === 'string' &&
    'instanceName' in value &&
    typeof value.instanceName === 'string' &&
    'databasePort' in value &&
    typeof value.databasePort === 'number'
  );
}

function isDatabaseInfoArray(value: unknown): value is DatabaseInfo[] {
  return Array.isArray(value) && value.every(isDatabaseInfo);
}

interface EnsuredDatabase {
  readonly url: string;
}

function isEnsuredDatabase(value: unknown): value is EnsuredDatabase {
  return (
    typeof value === 'object' && value !== null && 'url' in value && typeof value.url === 'string'
  );
}

export interface PostgresClient {
  readonly baseUrl: string;
  health(): Promise<{ version: string }>;
  /** `PUT /apps/<app>/databases/<id>` — ensure a named, persistent `@prisma/dev` server. Idempotent. */
  ensureDatabase(app: string, id: string, prismaDevModulePath: string): Promise<{ url: string }>;
  /** `GET /apps/<app>/databases`. */
  listDatabases(app: string): Promise<DatabaseInfo[]>;
  /** `DELETE /apps/<app>` — closes the app's servers and deletes their persisted data. */
  deleteApp(app: string): Promise<void>;
}

export function postgresClient(opts: DaemonRootOptions = {}): PostgresClient {
  const baseUrl = resolveBaseUrl('postgres', opts);

  return {
    baseUrl,

    async health() {
      const res = await expectOk(await fetch(`${baseUrl}/health`));
      const body: unknown = await res.json();
      if (!isHealthBody(body)) {
        throw new Error('malformed /health response from the postgres emulator');
      }
      return body;
    },

    async ensureDatabase(app, id, prismaDevModulePath) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/databases/${encodeSegment(id)}`;
      const res = await expectOk(
        await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prismaDevModulePath }),
        }),
      );
      const body: unknown = await res.json();
      if (!isEnsuredDatabase(body)) {
        throw new Error('malformed database-ensure response from the postgres emulator');
      }
      return body;
    },

    async listDatabases(app) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}/databases`;
      const res = await expectOk(await fetch(url));
      const body: unknown = await res.json();
      if (!isDatabaseInfoArray(body)) {
        throw new Error('malformed databases listing from the postgres emulator');
      }
      return body;
    },

    async deleteApp(app) {
      const url = `${baseUrl}/apps/${encodeSegment(app)}`;
      await expectOk(await fetch(url, { method: 'DELETE' }));
    },
  };
}
