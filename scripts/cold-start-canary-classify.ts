/**
 * Pass/fail logic for cold-start-canary.ts (PRO-217), split out for offline
 * unit testing — the cold-connect-canary-classify.ts pattern applied to the
 * Compute face of the cold-start family.
 *
 * PRO-217 (the ingress closes a first-touch connection while a scale-to-zero
 * service boots) is INTERMITTENT: on most cold hits the edge holds the
 * connection and the request just takes seconds, and only sometimes closes it
 * mid-establishment (~400 ms fast-fail, observed via examples/streams). One
 * touch against a freshly promoted instance can therefore land on one of
 * three outcomes, not two:
 *
 * - a 502 whose body names a socket close, arriving fast — the bug
 *   reproduced. A close only happens during the boot window, so this alone
 *   proves the touch reached a cold start; no further evidence is needed.
 * - a 201 that independent evidence (the deployment's own boot logs) confirms
 *   was sent before the app finished booting — the edge held the connection
 *   through a real cold start. Genuine evidence toward "fixed".
 * - a 201 that arrived before there was anything left to boot through — no
 *   cold start happened, so the touch says nothing about the bug either way.
 *
 * A canary that folds the second and third cases together (as this file once
 * did, mapping every 201 straight to "held") can report "fixed" from touches
 * that never went near a cold instance — see gotchas.md's PRO-217 entry for
 * the run that did exactly that. `classifyColdStartTouch` refuses to guess
 * the cold/warm distinction itself: the caller must resolve it (from
 * `classifyBootEvidence`, below) and pass the answer in.
 *
 * A second, separate defect survives even once the touch itself is
 * genuinely cold: PRO-217 being intermittent means "every touch this run
 * happened to hold" is the EXPECTED result of a run that is too small, not
 * proof the bug is gone. `classifyColdStartRun`'s bug-gone branch therefore
 * requires a minimum number of confirmed cold-start holds — see
 * `MIN_HELD_SAMPLES_FOR_BUG_GONE` below for the arithmetic.
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
export type ColdStartTouch = 'held' | 'closed' | 'no-cold-start' | 'other';

/**
 * The caller's answer to "did this touch actually race a boot?", decided by
 * `classifyBootEvidence` from the deployment's own logs before
 * `classifyColdStartTouch` is called:
 *
 * - `confirmed-cold`: the touch was sent clearly before the app's own
 *   `listening` line, by more than the clock-skew margin.
 * - `confirmed-warm`: the touch was sent clearly after `listening`, by more
 *   than the clock-skew margin — it landed on an instance that was already
 *   up.
 * - `unknown`: the deployment's logs never showed a `listening` line within
 *   the read window, or the touch landed within the margin of it, so which
 *   side of the boot it fell on cannot be said. This is a real "we don't
 *   know", not a guess dressed up as one of the other two.
 */
export type BootEvidence = 'confirmed-cold' | 'confirmed-warm' | 'unknown';

/**
 * Classifies one first-touch response from the CALLER's seat.
 *
 * A 201 only becomes `held` when `bootEvidence` is `confirmed-cold`;
 * `confirmed-warm` makes it `no-cold-start` (a successful append that proves
 * nothing, because nothing was booting when it landed), and `unknown` makes
 * it `other` — the log evidence could not place the touch on either side of
 * the boot, so the touch is inconclusive rather than assumed either way. A
 * 502 naming the close is `closed` regardless of `bootEvidence`: the close
 * itself only happens mid-boot, so it is its own proof.
 */
export function classifyColdStartTouch(
  status: number,
  body: string,
  bootEvidence: BootEvidence,
): ColdStartTouch {
  const lower = body.toLowerCase();
  if (status === 502 && CLOSE_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return 'closed';
  }
  if (status === 201) {
    if (bootEvidence === 'confirmed-cold') return 'held';
    if (bootEvidence === 'confirmed-warm') return 'no-cold-start';
    return 'other';
  }
  return 'other';
}

/**
 * Strips ANSI SGR color codes from spark's boot log lines (the platform's
 * own log lines are colorized; the app's own log lines observed so far are
 * not, but stripping first makes the timestamp regex robust either way).
 * Built from String.fromCharCode rather than a regex literal containing the
 * raw ESC byte, which Biome's noControlCharactersInRegex rule (rightly)
 * rejects.
 */
export function stripAnsiCodes(text: string): string {
  const ESC = String.fromCharCode(27);
  return text.split(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')).join('');
}

/**
 * The streams server's own boot line — e.g. "[2026-07-17T12:04:10.313Z]
 * [INFO] prisma-streams server listening on 0.0.0.0:3000" — read from a
 * deployment's log history (`?from_start=true`). Returns the timestamp it
 * logged, or undefined if the boot never reached it (or the log read didn't
 * cover it).
 */
export function findListeningTimestamp(logText: string): Date | undefined {
  const match = stripAnsiCodes(logText).match(
    /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)]\s*\[INFO]\s*prisma-streams server listening/,
  );
  const timestamp = match?.[1];
  return timestamp !== undefined ? new Date(timestamp) : undefined;
}

/**
 * `touchSentAt` is `new Date()` on the CI runner; `listeningAt` is parsed out
 * of a timestamp the streams server wrote with its own `new Date()` on a
 * Prisma Compute VM. Nothing keeps those two clocks in lockstep, so a
 * touch/listening gap of a few tens or hundreds of milliseconds is not by
 * itself proof of ordering — it could be clock skew rather than a genuine
 * race. Two well-behaved NTP-synced hosts (a GitHub Actions runner and a
 * cloud VM) are not expected to disagree by more than a few hundred
 * milliseconds; 2 seconds is a comfortable multiple of that, while still
 * being small next to the 3.5-22s boot windows this canary now samples (see
 * cold-start-canary.ts's SAMPLE_INTERVAL_MS comment), so it does not eat
 * into the touches it can confidently call one way or the other.
 */
export const CLOCK_SKEW_MARGIN_MS = 2_000;

/**
 * Decides, from the deployment's own boot log, which side of the boot a
 * touch landed on. Returns `unknown` — not a guess — when the log never
 * showed a `listening` line, or when the touch and `listening` are within
 * CLOCK_SKEW_MARGIN_MS of each other and cross-clock skew could plausibly
 * explain the gap either way.
 */
export function classifyBootEvidence(
  touchSentAt: Date,
  listeningAt: Date | undefined,
): BootEvidence {
  if (listeningAt === undefined) return 'unknown';
  const touchBeforeListeningByMs = listeningAt.getTime() - touchSentAt.getTime();
  if (touchBeforeListeningByMs >= CLOCK_SKEW_MARGIN_MS) return 'confirmed-cold';
  if (touchBeforeListeningByMs <= -CLOCK_SKEW_MARGIN_MS) return 'confirmed-warm';
  return 'unknown';
}

/**
 * The three exits a REQUIRED check needs (the job fails only on the
 * conclusive forcing signal):
 * - `bug-present` → exit 0 (a close occurred; today's normal),
 * - `bug-gone` → exit 1 (enough touches reached a genuinely fresh, booting
 *   instance and every one of them held that an all-held result is strong
 *   evidence, not luck — the actionable removal message is the point of the
 *   failure),
 * - `inconclusive` → exit 0 plus a CI warning annotation (loud, not blocking
 *   every PR on a deploy flake, a run that never managed to force a cold
 *   start, or a run too small to trust; a human should look).
 */
export type ColdStartVerdict = 'bug-present' | 'bug-gone' | 'inconclusive';

export interface ColdStartResult {
  readonly verdict: ColdStartVerdict;
  readonly message: string;
}

/**
 * The close rate `classifyColdStartRun` powers the bug-gone verdict against.
 * PRO-217 is intermittent, and the rates actually observed against this
 * stack run well above this number: a 60-second-spaced manual probe saw 3
 * closes out of 5 confirmed cold starts (60%), and an earlier round saw 3
 * closes out of 3 (100%). TARGET_CLOSE_RATE is deliberately set far below
 * both, at 20%, so the sample budget below stays conservative even if the
 * platform's real defect rate is much lower than anything observed so far —
 * the canary should not need the bug to be as reproducible as it is today in
 * order to still catch it.
 */
export const TARGET_CLOSE_RATE = 0.2;

/**
 * The most a bug-gone verdict is allowed to be "all held by luck": if the
 * true close rate were TARGET_CLOSE_RATE and the bug were still present, the
 * chance of seeing every one of MIN_HELD_SAMPLES_FOR_BUG_GONE independent
 * confirmed cold starts hold is at most this.
 */
export const MAX_FALSE_CLEAN_PROBABILITY = 0.05;

/**
 * The number of confirmed cold-start holds classifyColdStartRun requires
 * before it will say bug-gone. At a true close rate of TARGET_CLOSE_RATE,
 * the chance that N independent cold starts all happen to hold is
 * (1 - TARGET_CLOSE_RATE)^N; this is the smallest N for which that chance is
 * at or below MAX_FALSE_CLEAN_PROBABILITY:
 *
 *   0.8^13 ≈ 5.50% (not low enough)
 *   0.8^14 ≈ 4.40% (first N at or below 5%)
 *
 * so N = 14. Below that count, an all-held run is not evidence the bug is
 * gone — it is the outcome intermittency predicts most of the time from too
 * few samples.
 */
export const MIN_HELD_SAMPLES_FOR_BUG_GONE = Math.ceil(
  Math.log(MAX_FALSE_CLEAN_PROBABILITY) / Math.log(1 - TARGET_CLOSE_RATE),
);

function chanceAllHoldByLuck(heldCount: number): number {
  return (1 - TARGET_CLOSE_RATE) ** heldCount;
}

function asPercent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

/**
 * Aggregates N first touches. A close anywhere is decisive on its own (rule:
 * a close only happens mid-boot, so it needs no corroboration). Short of
 * that, a touch that landed on an already-warm instance (`no-cold-start`) or
 * came back some other inconclusive way (`other`) means the run never earned
 * an opinion from that touch, so ANY of those makes the whole run
 * `inconclusive` rather than mixing an uninformative touch into a "clean"
 * verdict. And even a run where every touch held is only allowed to say
 * "fixed" once it has collected MIN_HELD_SAMPLES_FOR_BUG_GONE confirmed
 * cold-start holds — see that constant's comment for why a smaller all-held
 * run is not evidence.
 */
export function classifyColdStartRun(touches: readonly ColdStartTouch[]): ColdStartResult {
  const n = touches.length;
  if (n === 0) return { verdict: 'inconclusive', message: 'Canary made no touches — broken.' };
  const count = (t: ColdStartTouch) => touches.filter((x) => x === t).length;
  const closed = count('closed');
  const held = count('held');
  const noColdStart = count('no-cold-start');
  const other = count('other');

  if (closed > 0) {
    return {
      verdict: 'bug-present',
      message:
        `Cold-start close still present (${closed}/${n} first touches closed, ${held} held, ` +
        `${noColdStart} never went cold) — PRO-217 not fixed; keep the PRO-219 backoff in ` +
        'the streams client class (client.ts).',
    };
  }

  if (noColdStart > 0 || other > 0) {
    return {
      verdict: 'inconclusive',
      message:
        `The canary failed to force a cold start on ${noColdStart + other}/${n} touches ` +
        `(${noColdStart} landed on an already-warm instance, ${other} were otherwise ` +
        'inconclusive) — a run that never reaches a cold instance has no opinion to report on ' +
        'PRO-217. A human should look; not blocking.',
    };
  }

  // Every touch reached a fresh, booting instance and held (noColdStart === 0,
  // other === 0, closed === 0), so held === n here. Whether that is enough
  // still depends on how many holds it actually is.
  if (held < MIN_HELD_SAMPLES_FOR_BUG_GONE) {
    return {
      verdict: 'inconclusive',
      message:
        `All ${held} confirmed cold-start touches held, but PRO-217 is intermittent, so that is ` +
        'the outcome a too-small sample is expected to produce even with the bug fully present: ' +
        'even at a conservative 20% close rate (well below the 60-100% close rates seen in manual ' +
        `reproduction against this stack), the chance that ${held} independent cold starts would ` +
        `all happen to hold is ${asPercent(chanceAllHoldByLuck(held))}. This run needs at least ` +
        `${MIN_HELD_SAMPLES_FOR_BUG_GONE} confirmed cold-start holds before an all-held result ` +
        `drops that chance to ${asPercent(MAX_FALSE_CLEAN_PROBABILITY)} or below (0.8^` +
        `${MIN_HELD_SAMPLES_FOR_BUG_GONE} ≈ ` +
        `${asPercent(chanceAllHoldByLuck(MIN_HELD_SAMPLES_FOR_BUG_GONE))}). Not blocking.`,
    };
  }

  return {
    verdict: 'bug-gone',
    message:
      `All ${n} first touches against genuinely fresh, still-booting instances were held to ` +
      `success — ${held} confirmed cold-start holds with zero closes. Even at a conservative 20% ` +
      'close rate (well below the 60-100% close rates seen in manual reproduction against this ' +
      'stack), the chance of that happening by luck alone is only ' +
      `${asPercent(chanceAllHoldByLuck(held))}, so this counts as real evidence: the platform no ` +
      'longer shows the PRO-217 close, and the workaround exists with no problem. To fix this ' +
      'build (you are seeing it because the cleanup is now due, not because of your change): ' +
      '1) delete IDEMPOTENT_BACKOFF and its uses in the streams client class ' +
      '(packages/1-prisma-cloud/2-shared-modules/streams/src/client.ts); ' +
      '2) remove scripts/cold-start-canary.ts, scripts/cold-start-canary-classify.ts (+ its ' +
      'test) and the "Cold-start canary (PRO-217)" job in .github/workflows/e2e-deploy.yml; ' +
      "3) drop the removal-guard paragraph from gotchas.md's PRO-217 entry; 4) close PRO-219.",
  };
}
