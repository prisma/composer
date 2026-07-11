/**
 * A fake worker for TESTING a system that depends on it — injected in place
 * of the real one so the router's integration test needs no deployed worker.
 * Serves the real `workerContract` (so its handler map is type-checked
 * against the same contract the real worker exposes) and records which
 * methods were called, so the test can assert the cron pipeline actually
 * reached the target. Test-only, deliberately outside `src/`, so it never
 * rides into the deployed artifact.
 *
 * A fresh call log per test needs a fresh handler, so this exports a factory
 * rather than a single served instance (contrast auth's `fake.ts`, whose
 * `verify` has no state to reset between tests).
 */
import { compute } from '@prisma/app-cloud';
import node from '@prisma/app-node';
import { serve } from '@prisma/app-rpc';
import { workerContract } from '../src/contract.ts';

const fakeWorker = compute({
  name: 'worker-fake',
  deps: {},
  build: node({ module: import.meta.url, entry: 'fake.ts' }),
  expose: { rpc: workerContract },
});

export interface FakeWorker {
  readonly fetch: (req: Request) => Promise<Response>;
  readonly calls: readonly string[];
}

export function createFakeWorker(): FakeWorker {
  const calls: string[] = [];
  const fetch = serve(fakeWorker, {
    rpc: {
      tick: async () => {
        calls.push('tick');
        return { ok: true };
      },
      refreshMrr: async () => {
        calls.push('refreshMrr');
        return { ok: true };
      },
    },
  });
  return { fetch, calls };
}
