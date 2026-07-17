/**
 * Pass/fail logic for cold-start-canary.ts (PRO-217), split out for offline
 * unit testing — the cold-connect-canary-classify.ts pattern applied to the
 * Compute face of the cold-start family.
 *
 * PRO-217 (the ingress closes a first-touch connection while a scale-to-zero
 * service boots) is INTERMITTENT: on most cold hits the edge holds the
 * connection and the request just takes seconds, and only sometimes closes it
 * mid-establishment (~400 ms fast-fail, observed via examples/streams). So one
 * touch can't tell "fixed" from "the edge held this time": the canary touches
 * N freshly promoted instances and only trusts the aggregate — a single close
 * proves the bug, and only a unanimous run of holds is evidence (not proof)
 * it may be gone.
 */

/**
 * The caller (the jobs service's 502-with-cause guard) surfaces the close as
 * `streams unreachable: … socket connection was closed …`; a direct Bun/node
 * caller shows the same message or an ECONNRESET/ECONNREFUSED code. Keep in
 * sync with gotchas.md's PRO-217 entry.
 */
const CLOSE_FRAGMENTS = [
  'socket connection was closed',
  'econnreset',
  'econnrefused',
  'socket hang up',
];

/** One first-touch outcome against a freshly promoted instance. */
export type ColdStartTouch = 'held' | 'closed' | 'other';

/**
 * Classifies one first-touch response from the CALLER's seat: the append
 * succeeding (201) means the edge held the connection through the boot; a 502
 * whose cause names a socket close is PRO-217; anything else (a timeout, an
 * app error, a broken canary) is inconclusive.
 */
export function classifyColdStartTouch(status: number, body: string): ColdStartTouch {
  if (status === 201) return 'held';
  const lower = body.toLowerCase();
  if (status === 502 && CLOSE_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return 'closed';
  }
  return 'other';
}

/**
 * The three exits a REQUIRED check needs (the job fails only on the
 * conclusive forcing signal):
 * - `bug-present` → exit 0 (a close occurred; today's normal),
 * - `bug-gone` → exit 1 (all held — the workaround exists with no problem;
 *   the actionable removal message is the point of the failure),
 * - `inconclusive` → exit 0 plus a CI warning annotation (loud, not blocking
 *   every PR on a deploy flake; a human should look).
 */
export type ColdStartVerdict = 'bug-present' | 'bug-gone' | 'inconclusive';

export interface ColdStartResult {
  readonly verdict: ColdStartVerdict;
  readonly message: string;
}

/**
 * Aggregates N first touches with the FT-5226 canary's unanimity rule; see
 * {@link ColdStartVerdict} for what each verdict makes the job do.
 */
export function classifyColdStartRun(touches: readonly ColdStartTouch[]): ColdStartResult {
  const n = touches.length;
  if (n === 0) return { verdict: 'inconclusive', message: 'Canary made no touches — broken.' };
  const count = (t: ColdStartTouch) => touches.filter((x) => x === t).length;
  const closed = count('closed');
  const held = count('held');

  if (closed > 0) {
    return {
      verdict: 'bug-present',
      message:
        `Cold-start close still present (${closed}/${n} first touches closed, ${held} held) — ` +
        'PRO-217 not fixed; keep the PRO-219 backoff in createStreamsClient.',
    };
  }
  if (held === n) {
    return {
      verdict: 'bug-gone',
      message:
        `All ${n} first touches against fresh instances were held to success — the platform no ` +
        'longer shows the PRO-217 close, so the workaround exists with no problem. To fix this ' +
        'build (you are seeing it because the cleanup is now due, not because of your change): ' +
        '1) delete IDEMPOTENT_BACKOFF and its uses in createStreamsClient ' +
        '(packages/1-prisma-cloud/2-shared-modules/streams/src/client.ts); ' +
        '2) remove scripts/cold-start-canary.ts, scripts/cold-start-canary-classify.ts (+ its ' +
        'test) and the "Cold-start canary (PRO-217)" job in .github/workflows/e2e-deploy.yml; ' +
        "3) drop the removal-guard paragraph from gotchas.md's PRO-217 entry; 4) close PRO-219.",
    };
  }
  return {
    verdict: 'inconclusive',
    message:
      `Inconclusive across ${n} touches (${held} held, ${count('other')} other, 0 closes) — ` +
      'a slow boot, an app error, or a broken canary. A human should look; not blocking.',
  };
}
