/**
 * Pass/fail logic for cold-connect-canary.ts, split out for offline unit
 * testing. Duplicates the transient-error signatures from
 * packages/compose-cloud/src/pg-connection.ts (not exported from that package's
 * public entry points) — keep in sync if that list changes.
 *
 * FT-5226 (PPg cold-connect rejection) is INTERMITTENT — the edge proxy rejects
 * a cold DB's first connect while its upstream warms, but a fast-enough connect
 * occasionally slips through. So one connect can't tell "fixed" from "got lucky
 * once": the canary samples N fresh cold DBs and only trusts a UNANIMOUS result.
 */

const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

const INCONCLUSIVE_CODES = new Set(['ETIMEDOUT']);

const TRANSIENT_MESSAGE_FRAGMENTS = [
  'upstream database',
  'connection terminated',
  'connection refused',
  'terminating connection',
  'server closed the connection',
];

// FT-5226 manifests as an ACTIVE rejection. A client-side connect timeout is
// inconclusive (could be a slow-but-fixed cold start) and must not count as PASS.
const INCONCLUSIVE_MESSAGE_FRAGMENTS = ['connection timeout', 'timeout expired'];

function errorInfo(error: unknown): { code: string | undefined; message: string } {
  if (typeof error !== 'object' || error === null)
    return { code: undefined, message: String(error) };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return { code, message };
}

function isTransient(error: unknown): boolean {
  const { code, message } = errorInfo(error);
  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;
  const lower = message.toLowerCase();
  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function isInconclusive(error: unknown): boolean {
  const { code, message } = errorInfo(error);
  if (code !== undefined && INCONCLUSIVE_CODES.has(code)) return true;
  const lower = message.toLowerCase();
  return INCONCLUSIVE_MESSAGE_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** One cold-connect attempt's outcome. `rejected` is the FT-5226 signal; `success` means the connect went through; `timeout`/`other` are inconclusive. */
export type ColdConnectSample = 'rejected' | 'success' | 'timeout' | 'other';

/** Classifies a single bare-connect result: no error → success; active transient reject → rejected (FT-5226); connect timeout → timeout; anything else (auth, quota) → other. */
export function classifyColdConnectSample(error: unknown): ColdConnectSample {
  if (error === undefined) return 'success';
  if (isInconclusive(error)) return 'timeout';
  if (isTransient(error)) return 'rejected';
  return 'other';
}

/**
 * The three exits a REQUIRED check needs (the job fails only on the
 * conclusive forcing signal): `bug-present` → exit 0; `bug-gone` → exit 1
 * (all clean — remove the workaround); `inconclusive` → exit 0 plus a CI
 * warning annotation.
 */
export type ColdConnectVerdict = 'bug-present' | 'bug-gone' | 'inconclusive';

export interface ColdConnectResult {
  readonly verdict: ColdConnectVerdict;
  readonly message: string;
}

/**
 * Aggregates N cold-connect samples with UNANIMITY, so one flaky connect can't
 * flip the verdict; see {@link ColdConnectVerdict} for what each verdict makes
 * the job do.
 */
export function classifyColdConnectRun(samples: readonly ColdConnectSample[]): ColdConnectResult {
  const n = samples.length;
  if (n === 0) return { verdict: 'inconclusive', message: 'Canary took no samples — broken.' };
  const count = (s: ColdConnectSample) => samples.filter((x) => x === s).length;
  const rejected = count('rejected');
  const success = count('success');

  if (rejected > 0) {
    return {
      verdict: 'bug-present',
      message: `Cold-connect rejection still present (${rejected}/${n} rejected) — FT-5226 not fixed; keep withConnectionRetry.`,
    };
  }
  if (success === n) {
    return {
      verdict: 'bug-gone',
      message:
        `All ${n} cold connects succeeded — PPg no longer rejects a fresh database's first ` +
        'connect, so the workaround exists with no problem. To fix this build (you are seeing ' +
        'it because the cleanup is now due, not because of your change): 1) remove ' +
        'withConnectionRetry and its uses ' +
        '(packages/1-prisma-cloud/1-extensions/target/src/pg-connection.ts); 2) remove ' +
        'scripts/cold-connect-canary.ts, scripts/cold-connect-canary-classify.ts (+ its test) ' +
        'and the "Cold-connect canary (FT-5226)" job in .github/workflows/e2e-deploy.yml; ' +
        "3) drop the removal-guard line from gotchas.md's FT-5226 entry; 4) close FT-5226's " +
        'follow-up if one is open.',
    };
  }
  return {
    verdict: 'inconclusive',
    message: `Inconclusive across ${n} samples (${success} ok, ${count('timeout')} timeout, ${count('other')} other, 0 active rejections) — FT-5226 may be fixed via a slow cold start, or the canary/credentials are broken. A human should look; not blocking.`,
  };
}
