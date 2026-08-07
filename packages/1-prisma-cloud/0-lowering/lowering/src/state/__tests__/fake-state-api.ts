import * as http from 'node:http';

/**
 * An in-process fake of the platform Alchemy state API: the alchemy
 * `HttpStateApi` wire contract (see node_modules/alchemy/src/state/
 * HttpStateApi.ts) mounted under `/v1/projects/{p}/branches/{b}/alchemy-state`,
 * plus the deploy-lease endpoints and the two Management API listings the
 * state layer touches (`/v1/apps`, `/v1/projects/{p}/branches`).
 *
 * Wire fidelity the tests depend on: absent values answer 200 with a JSON
 * `null` body (not 204); PUT echoes its payload; DELETE answers 204; the fqn
 * path segment arrives double-encoded and the server decodes it once beyond
 * transport decoding. State operations and the heartbeat/release enforce the
 * lease: a missing or stale `Alchemy-State-Lease-Id` answers 409 (state ops)
 * or 404 (lease calls).
 */

interface Lease {
  leaseId: string;
  holder: string;
  expiresAt: string;
}

export interface RequestLogEntry {
  method: string;
  path: string;
}

export interface FakeApp {
  id: string;
  name: string;
  projectId: string;
  branchId: string;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const noContent = (res: http.ServerResponse): void => {
  res.writeHead(204);
  res.end();
};

const apiError = (
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void => {
  json(res, status, { error: { code, message } });
};

const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });

export class FakeStateApi {
  readonly requests: RequestLogEntry[] = [];
  readonly apps: FakeApp[] = [];
  /** (stack \0 stage \0 fqn) → stored state. */
  private readonly resources = new Map<string, unknown>();
  /** (stack \0 stage) → stack output. */
  private readonly outputs = new Map<string, unknown>();
  /** (branch \0 stack \0 stage) → live lease. */
  private readonly leases = new Map<string, Lease>();
  private leaseCounter = 0;
  private server: http.Server | undefined;
  private originValue = '';

  get origin(): string {
    return this.originValue;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fake state API failed to bind a TCP port');
    }
    this.originValue = `http://127.0.0.1:${String(address.port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Clears every lease, stored state, app, and the request log — a fresh server between tests. */
  reset(): void {
    this.leases.clear();
    this.resources.clear();
    this.outputs.clear();
    this.apps.length = 0;
    this.requests.length = 0;
  }

  countRequests(pattern: RegExp): number {
    return this.requests.filter((r) => pattern.test(`${r.method} ${r.path}`)).length;
  }

  /** Expires every live lease — the next state op or heartbeat sees the lease as lost. */
  revokeAllLeases(): void {
    this.leases.clear();
  }

  liveLeaseIds(): string[] {
    return [...this.leases.values()].map((l) => l.leaseId);
  }

  seedResource(stack: string, stage: string, fqn: string, value: unknown): void {
    this.resources.set([stack, stage, fqn].join('\0'), value);
  }

  private leaseByHeader(req: http.IncomingMessage): Lease | undefined {
    const id = req.headers['alchemy-state-lease-id'];
    return [...this.leases.values()].find((l) => l.leaseId === id);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.originValue);
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname });

    // Transport decoding: one decodeURIComponent per raw segment.
    const segments = url.pathname
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));

    if (segments[0] !== 'v1') return apiError(res, 404, 'not_found', 'unknown path');

    if (segments[1] === 'apps' && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const branchId = url.searchParams.get('branchId');
      const data = this.apps.filter(
        (a) =>
          (projectId === null || a.projectId === projectId) &&
          (branchId === null || a.branchId === branchId),
      );
      return json(res, 200, { data, pagination: { nextCursor: null, hasMore: false } });
    }

    if (
      segments[1] === 'projects' &&
      segments[3] === 'branches' &&
      segments.length === 4 &&
      method === 'GET'
    ) {
      return json(res, 200, {
        data: [{ id: 'br-default', isDefault: true }],
        pagination: { nextCursor: null, hasMore: false },
      });
    }

    if (
      segments[1] !== 'projects' ||
      segments[3] !== 'branches' ||
      segments[5] !== 'alchemy-state'
    ) {
      return apiError(res, 404, 'not_found', 'unknown path');
    }
    const branchId = segments[4] ?? '';
    const rest = segments.slice(6);

    if (rest[0] === 'lease') return this.handleLease(req, res, method, branchId);
    if (rest[0] === 'version' && method === 'GET') return json(res, 200, { version: 5 });
    if (rest[0] !== 'state' || rest[1] !== 'stacks') {
      return apiError(res, 404, 'not_found', 'unknown path');
    }
    return this.handleState(req, res, method, branchId, rest.slice(2), url);
  }

  private async handleLease(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    branchId: string,
  ): Promise<void> {
    if (method === 'POST') {
      const body = await readBody(req);
      const stack = String(body['stack'] ?? '');
      const stage = String(body['stage'] ?? '');
      const key = [branchId, stack, stage].join('\0');
      const existing = this.leases.get(key);
      if (existing !== undefined) {
        return apiError(
          res,
          409,
          'lease_held',
          `the deploy lease for stage "${stage}" is held by ${existing.holder}`,
        );
      }
      this.leaseCounter += 1;
      const lease: Lease = {
        leaseId: `lease-${String(this.leaseCounter)}`,
        holder: String(body['holderDescription'] ?? 'unknown'),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      this.leases.set(key, lease);
      return json(res, 201, { data: { leaseId: lease.leaseId, expiresAt: lease.expiresAt } });
    }

    const lease = this.leaseByHeader(req);
    if (lease === undefined) {
      return apiError(res, 404, 'lease_not_found', 'no unexpired lease matches the given id');
    }
    if (method === 'PATCH') {
      lease.expiresAt = new Date(Date.now() + 60_000).toISOString();
      return json(res, 200, { data: { leaseId: lease.leaseId, expiresAt: lease.expiresAt } });
    }
    if (method === 'DELETE') {
      for (const [key, value] of this.leases) {
        if (value.leaseId === lease.leaseId) this.leases.delete(key);
      }
      return noContent(res);
    }
    return apiError(res, 404, 'not_found', 'unknown path');
  }

  private handleState(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    branchId: string,
    path: readonly string[],
    url: URL,
  ): Promise<void> | void {
    if (this.leaseByHeader(req) === undefined) {
      return apiError(
        res,
        409,
        'lease_required',
        'every state operation requires a live deploy lease',
      );
    }

    // GET /state/stacks
    if (path.length === 0 && method === 'GET') {
      const stacks = new Set<string>();
      for (const key of [...this.resources.keys(), ...this.outputs.keys()]) {
        stacks.add(key.split('\0')[0] ?? '');
      }
      return json(res, 200, [...stacks].sort());
    }

    const stack = path[0] ?? '';

    // DELETE /state/stacks/:stack[?stage=…]
    if (path.length === 1 && method === 'DELETE') {
      const stage = url.searchParams.get('stage');
      for (const map of [this.resources, this.outputs]) {
        for (const key of [...map.keys()]) {
          const [s, st] = key.split('\0');
          if (s === stack && (stage === null || st === stage)) map.delete(key);
        }
      }
      return noContent(res);
    }

    // GET /state/stacks/:stack/stages
    if (path[1] === 'stages' && path.length === 2 && method === 'GET') {
      const stages = new Set<string>();
      for (const key of [...this.resources.keys(), ...this.outputs.keys()]) {
        const [s, st] = key.split('\0');
        if (s === stack && st !== undefined) stages.add(st);
      }
      return json(res, 200, [...stages].sort());
    }

    const stage = path[2] ?? '';
    const scopePrefix = `${stack}\0${stage}\0`;

    // …/stages/:stage/resources
    if (path[3] === 'resources' && path.length === 4 && method === 'GET') {
      const fqns = [...this.resources.keys()]
        .filter((key) => key.startsWith(scopePrefix))
        .map((key) => key.slice(scopePrefix.length))
        .sort();
      return json(res, 200, fqns);
    }

    // …/stages/:stage/resources/:fqn — the segment is still encoded once
    // after transport decoding (the stock client double-encodes): decode once.
    if (path[3] === 'resources' && path.length === 5) {
      const fqn = decodeURIComponent(path[4] ?? '');
      const key = scopePrefix + fqn;
      if (method === 'GET') return json(res, 200, this.resources.get(key) ?? null);
      if (method === 'PUT') {
        return readBody(req).then((body) => {
          this.resources.set(key, body);
          return json(res, 200, body);
        });
      }
      if (method === 'DELETE') {
        this.resources.delete(key);
        return noContent(res);
      }
    }

    // …/stages/:stage/replaced-resources
    if (path[3] === 'replaced-resources' && method === 'GET') {
      const isReplaced = (value: unknown): boolean =>
        typeof value === 'object' &&
        value !== null &&
        'status' in value &&
        value.status === 'replaced';
      const replaced = [...this.resources.entries()]
        .filter(([key, value]) => key.startsWith(scopePrefix) && isReplaced(value))
        .map(([, value]) => value);
      return json(res, 200, replaced);
    }

    // …/stages/:stage/output
    if (path[3] === 'output') {
      const key = `${stack}\0${stage}`;
      if (method === 'GET') return json(res, 200, this.outputs.get(key) ?? null);
      if (method === 'PUT') {
        return readBody(req).then((body) => {
          this.outputs.set(key, body);
          return json(res, 200, body);
        });
      }
    }

    return apiError(res, 404, 'not_found', `unknown state path: ${branchId}/${path.join('/')}`);
  }
}

/** Starts a fake and guarantees teardown via the returned stop. */
export const startFakeStateApi = async (): Promise<FakeStateApi> => {
  const fake = new FakeStateApi();
  await fake.start();
  return fake;
};
