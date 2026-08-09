/**
 * Decision logic for cold-connect-canary.ts — which outcomes count as what, and
 * how a run collects its samples — split out for offline unit testing, with no
 * Management API and no real waiting. Duplicates the transient-error signatures from
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
 * How many all-success samples it takes before `bug-gone` is claimed. The
 * rejection is intermittent, so a short unanimous streak is the expected
 * outcome of a run that is too small, not evidence of a fix. Same figure as
 * the cold-start canary's hold requirement (gotchas.md, PRO-217).
 *
 * This number alone does NOT carry the confidence it looks like it does. It
 * was justified as "at a conservative 20% rejection rate, 0.8^14 ≈ 4.4%
 * chance of a lucky streak", which assumes every sample is an independent
 * draw at a fixed rate. Measured over 20 runs (63 samples) that assumption is
 * false: the overall rate was 30%, but 8 of those runs rejected on their very
 * first sample while others ran 8, 10 and 14 samples clean. The outcome is
 * dominated by conditions that hold for a whole run, so raising this number
 * mostly buys more samples from runs that were already sailing through — one
 * of which produced a false bug-gone verdict on 2026-08-09.
 *
 * What makes a sample worth counting is that it met a cold database at all,
 * which is why the canary now spaces its samples (SAMPLE_INTERVAL_MS in
 * cold-connect-canary.ts). Re-derive that interval before this number.
 */
export const MIN_BUG_GONE_SAMPLES = 14;

/**
 * Aggregates cold-connect samples with UNANIMITY, so one flaky connect can't
 * flip the verdict — and `bug-gone` additionally needs
 * {@link MIN_BUG_GONE_SAMPLES} samples, so a short lucky streak can't force
 * the workaround's removal; see {@link ColdConnectVerdict} for what each
 * verdict makes the job do.
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
  if (success === n && n < MIN_BUG_GONE_SAMPLES) {
    return {
      verdict: 'inconclusive',
      message:
        `All ${n} cold connects succeeded, but ${MIN_BUG_GONE_SAMPLES} are needed before ` +
        'claiming FT-5226 is fixed — a short unanimous streak is luck, not evidence. ' +
        'Not blocking; keep withConnectionRetry.',
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

export interface SampleCollectionOptions {
  /** Provisions a fresh cold database and returns its first-connect outcome. */
  readonly sample: (index: number) => Promise<ColdConnectSample>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Samples taken before the loop may stop on a non-rejection outcome. */
  readonly minSamples: number;
  /** Spacing between samples, so each one meets a genuinely cold database. */
  readonly intervalMs: number;
  /** The run's own wall-clock budget, sitting below the CI job's timeout. */
  readonly maxRunMs: number;
  readonly log: (line: string) => void;
}

/**
 * Samples until the verdict is settled: one rejection settles it outright, and
 * an all-success streak keeps going to {@link MIN_BUG_GONE_SAMPLES} because
 * anything shorter is luck rather than the bug-gone forcing signal.
 *
 * Samples are spaced. Stopping early on the run's budget can never manufacture
 * a bug-gone verdict, because short of {@link MIN_BUG_GONE_SAMPLES} an
 * all-success run classifies as inconclusive.
 */
export async function collectColdConnectSamples(
  opts: SampleCollectionOptions,
): Promise<ColdConnectSample[]> {
  const samples: ColdConnectSample[] = [];
  const startedAt = opts.now();
  while (
    samples.length < opts.minSamples ||
    (samples.length < MIN_BUG_GONE_SAMPLES && samples.every((s) => s === 'success'))
  ) {
    const elapsed = opts.now() - startedAt;
    const stop = (why: string) => {
      opts.log(`  stopping after ${samples.length} sample(s): ${why}`);
    };
    if (elapsed >= opts.maxRunMs) {
      stop(`the run's own ${opts.maxRunMs}ms budget is spent.`);
      break;
    }
    // Never before the first sample — that would just delay the run without
    // making anything colder.
    if (samples.length > 0) {
      // Don't start a wait the budget cannot cover. Without this the loop can
      // begin a full interval with a second left and then sample on the far
      // side of it, overrunning the budget by more than the interval itself.
      // Checking here also makes a recheck after the sleep redundant.
      if (elapsed + opts.intervalMs >= opts.maxRunMs) {
        stop(`no room in the ${opts.maxRunMs}ms budget for another ${opts.intervalMs}ms wait.`);
        break;
      }
      opts.log(`  waiting ${opts.intervalMs}ms before sample #${samples.length}…`);
      await opts.sleep(opts.intervalMs);
    }
    const sample = await opts.sample(samples.length);
    samples.push(sample);
    if (sample === 'rejected') break;
  }
  return samples;
}
