import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deleteProjectDeep,
  type HttpCall,
  type HttpResponse,
  isEphemeralCiProjectName,
  isLegacyStaleProjectName,
  LEGACY_STALE_PROJECT_NAMES,
  PROTECTED_PROJECT_NAMES,
} from './ci-cleanup-utils.ts';

const PREFIXES = ['storefront-auth', 'orm-demo'];

describe('isEphemeralCiProjectName', () => {
  it('matches exactly <prefix>-ci-<digits> for each given prefix', () => {
    assert.equal(isEphemeralCiProjectName('storefront-auth-ci-12345', PREFIXES), true);
    assert.equal(isEphemeralCiProjectName('orm-demo-ci-1234567890', PREFIXES), true);
  });

  it('rejects the standing (non-ci) app names', () => {
    assert.equal(isEphemeralCiProjectName('storefront-auth', PREFIXES), false);
    assert.equal(isEphemeralCiProjectName('orm-demo', PREFIXES), false);
  });

  it('rejects near-misses: wrong prefix, missing run id, non-digit id, extra suffix', () => {
    assert.equal(isEphemeralCiProjectName('datahub-ci-123', PREFIXES), false);
    assert.equal(isEphemeralCiProjectName('orm-demo-ci-', PREFIXES), false);
    assert.equal(isEphemeralCiProjectName('orm-demo-ci-abc', PREFIXES), false);
    assert.equal(isEphemeralCiProjectName('orm-demo-ci-123-extra', PREFIXES), false);
    assert.equal(isEphemeralCiProjectName('a-orm-demo-ci-123', PREFIXES), false);
  });

  it('never matches the hosted deploy-state project, even with a hostile prefix', () => {
    assert.equal(isEphemeralCiProjectName('prisma-composer-state', PREFIXES), false);
    // Even a prefix crafted so the pattern WOULD match is hard-denied.
    assert.equal(
      isEphemeralCiProjectName('prisma-composer-state', ['prisma-composer-state']),
      false,
    );
    assert.ok(PROTECTED_PROJECT_NAMES.includes('prisma-composer-state'));
  });

  it('treats prefixes literally — regex metacharacters cannot widen the match', () => {
    assert.equal(isEphemeralCiProjectName('orm-demoX-ci-1', ['orm-demo.']), false);
    assert.equal(isEphemeralCiProjectName('anything-ci-1', ['.*']), false);
  });

  it('requires at least one prefix', () => {
    assert.throws(() => isEphemeralCiProjectName('orm-demo-ci-1', []));
  });
});

describe('isLegacyStaleProjectName', () => {
  it('matches the pre-rename state-store name', () => {
    assert.equal(isLegacyStaleProjectName('makerkit-state'), true);
  });

  it('rejects the current state-store name and anything else', () => {
    assert.equal(isLegacyStaleProjectName('prisma-composer-state'), false);
    assert.equal(isLegacyStaleProjectName('storefront-auth-ci-1'), false);
    assert.equal(isLegacyStaleProjectName('makerkit-state-old'), false);
  });

  it('the current state project name can never be a legacy stale name', () => {
    for (const protectedName of PROTECTED_PROJECT_NAMES) {
      assert.ok(!LEGACY_STALE_PROJECT_NAMES.includes(protectedName));
    }
  });
});

// --- deleteProjectDeep: the 409 → compute-teardown → retry sequencing, with a mocked fetch ---

const PROJECT = { id: 'proj_1', name: 'orm-demo-ci-42' };
const OK: HttpResponse = { status: 200, ok: true, body: '{}' };
const GONE: HttpResponse = { status: 404, ok: false, body: 'not found' };
const ACTIVE_DEPLOYMENT: HttpResponse = {
  status: 409,
  ok: false,
  body: '{"code":"client-error","message":"Cannot delete project: active deployment"}',
};
const NOT_DELETE_SAFE: HttpResponse = {
  status: 409,
  ok: false,
  body: 'compute service did not reach a delete-safe state',
};
const SERVICES: HttpResponse = {
  status: 200,
  ok: true,
  body: JSON.stringify({
    data: [
      { id: 'svc_a', name: 'widgets' },
      { id: 'svc_b', name: 'worker' },
    ],
  }),
};

/** A scripted mock: pops the next response for each `METHOD path-prefix` key, recording every call. */
function scriptedHttp(script: Record<string, HttpResponse[]>): {
  http: HttpCall;
  calls: string[];
} {
  const calls: string[] = [];
  const http: HttpCall = (method, path) => {
    calls.push(`${method} ${path}`);
    const key = Object.keys(script).find((k) => `${method} ${path}`.startsWith(k));
    const queue = key === undefined ? undefined : script[key];
    const next = queue?.shift();
    if (next === undefined) throw new Error(`unscripted call: ${method} ${path}`);
    return Promise.resolve(next);
  };
  return { http, calls };
}

const fastOpts = (log: string[] = []) => ({
  log: (line: string) => log.push(line),
  sleep: () => Promise.resolve(),
  serviceDeleteAttempts: 3,
  serviceDeleteDelayMs: 0,
  projectDeleteAttempts: 3,
  projectDeleteDelayMs: 0,
});

describe('deleteProjectDeep', () => {
  it('returns true on a plain first-try delete (and a 404 counts as gone)', async () => {
    for (const first of [OK, GONE]) {
      const { http, calls } = scriptedHttp({ 'DELETE /projects/proj_1': [first] });
      assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts()), true);
      assert.deepEqual(calls, ['DELETE /projects/proj_1']);
    }
  });

  it('reports a thrown transport error as "not gone" instead of propagating it', async () => {
    // The sweep in ci-cleanup.ts deletes projects in a loop, so a thrown
    // error here would abandon every project after this one.
    const log: string[] = [];
    const throwing: HttpCall = () => Promise.reject(new Error('socket hang up'));
    assert.equal(await deleteProjectDeep(throwing, PROJECT, fastOpts(log)), false);
    assert.ok(log.some((l) => l.includes('socket hang up')));
  });

  it('retries past a transport blip in the post-teardown project delete', async () => {
    const NO_SERVICES: HttpResponse = { status: 200, ok: true, body: '{"data":[]}' };
    const steps: (HttpResponse | Error)[] = [
      ACTIVE_DEPLOYMENT, // DELETE /projects — live compute blocks it
      NO_SERVICES, // GET /apps
      new Error('ECONNRESET'), // DELETE /projects — the blip
      OK, // DELETE /projects — the retry
    ];
    let i = 0;
    const flaky: HttpCall = () => {
      const next = steps[i++];
      if (next === undefined) throw new Error('unscripted call');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    assert.equal(await deleteProjectDeep(flaky, PROJECT, fastOpts()), true);
    assert.equal(i, 4);
  });

  it('on 409 active-deployment: lists services, deletes each, then retries the project delete', async () => {
    const log: string[] = [];
    const { http, calls } = scriptedHttp({
      'DELETE /projects/proj_1': [ACTIVE_DEPLOYMENT, OK],
      'GET /apps?projectId=proj_1': [SERVICES],
      'DELETE /apps/svc_a': [OK],
      'DELETE /apps/svc_b': [OK],
    });
    assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts(log)), true);
    assert.deepEqual(calls, [
      'DELETE /projects/proj_1',
      'GET /apps?projectId=proj_1&limit=100',
      'DELETE /apps/svc_a',
      'DELETE /apps/svc_b',
      'DELETE /projects/proj_1',
    ]);
    assert.ok(log.some((l) => l.includes('tearing its apps down')));
    assert.ok(log.some((l) => l.includes('"widgets"')));
    assert.ok(log.some((l) => l.includes('"worker"')));
  });

  it('retries a service delete only while the platform says "did not reach a delete-safe state"', async () => {
    const { http, calls } = scriptedHttp({
      'DELETE /projects/proj_1': [ACTIVE_DEPLOYMENT, OK],
      'GET /apps?projectId=proj_1': [SERVICES],
      'DELETE /apps/svc_a': [NOT_DELETE_SAFE, NOT_DELETE_SAFE, OK],
      'DELETE /apps/svc_b': [GONE],
    });
    assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts()), true);
    assert.equal(calls.filter((c) => c === 'DELETE /apps/svc_a').length, 3);
  });

  it('does NOT retry a service delete on a non-delete-safe error — logs and moves on', async () => {
    const log: string[] = [];
    const boom: HttpResponse = { status: 500, ok: false, body: 'kaboom' };
    const { http, calls } = scriptedHttp({
      'DELETE /projects/proj_1': [ACTIVE_DEPLOYMENT, OK],
      'GET /apps?projectId=proj_1': [SERVICES],
      'DELETE /apps/svc_a': [boom],
      'DELETE /apps/svc_b': [OK],
    });
    // svc_b still gets deleted and the project delete still retried.
    assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts(log)), true);
    assert.equal(calls.filter((c) => c === 'DELETE /apps/svc_a').length, 1);
    assert.ok(log.some((l) => l.includes('"widgets" delete failed: 500')));
  });

  it('retries the post-teardown project delete (eventually consistent), bounded', async () => {
    const { http, calls } = scriptedHttp({
      'DELETE /projects/proj_1': [ACTIVE_DEPLOYMENT, ACTIVE_DEPLOYMENT, ACTIVE_DEPLOYMENT, OK],
      'GET /apps?projectId=proj_1': [SERVICES],
      'DELETE /apps/svc_a': [OK],
      'DELETE /apps/svc_b': [OK],
    });
    assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts()), true);
    // first attempt + 3 post-teardown retries (attempts=3 → the 4th scripted OK lands on the 3rd retry)
    assert.equal(calls.filter((c) => c === 'DELETE /projects/proj_1').length, 4);
  });

  it('gives up (false) when the project delete still 409s after the bounded retries', async () => {
    const log: string[] = [];
    const { http } = scriptedHttp({
      'DELETE /projects/proj_1': [
        ACTIVE_DEPLOYMENT,
        ACTIVE_DEPLOYMENT,
        ACTIVE_DEPLOYMENT,
        ACTIVE_DEPLOYMENT,
      ],
      'GET /apps?projectId=proj_1': [SERVICES],
      'DELETE /apps/svc_a': [OK],
      'DELETE /apps/svc_b': [OK],
    });
    assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts(log)), false);
    assert.ok(log.some((l) => l.includes('still failing')));
  });

  it('a non-active-deployment failure is logged and yields false without touching compute', async () => {
    const log: string[] = [];
    const forbidden: HttpResponse = { status: 403, ok: false, body: 'forbidden' };
    const { http, calls } = scriptedHttp({ 'DELETE /projects/proj_1': [forbidden] });
    assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts(log)), false);
    assert.deepEqual(calls, ['DELETE /projects/proj_1']);
    assert.ok(log.some((l) => l.includes('403')));
  });

  it('fails soft when the app listing itself fails', async () => {
    const log: string[] = [];
    const { http } = scriptedHttp({
      'DELETE /projects/proj_1': [ACTIVE_DEPLOYMENT],
      'GET /apps?projectId=proj_1': [{ status: 500, ok: false, body: 'oops' }],
    });
    assert.equal(await deleteProjectDeep(http, PROJECT, fastOpts(log)), false);
    assert.ok(log.some((l) => l.includes('could not list apps')));
  });
});
