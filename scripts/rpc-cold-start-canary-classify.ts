/**
 * Pass/fail logic for rpc-cold-start-canary.ts (PRO-217, service-RPC face) —
 * the service-rpc sibling of cold-start-canary-classify.ts, same intermittent-
 * bug arithmetic applied to a direct `POST <url>/rpc/<method>` touch instead
 * of the streams module's `POST /jobs`.
 *
 * A touch against a freshly promoted `auth.service` instance lands on one of
 * four outcomes:
 *
 * - the connection itself is reset mid-establishment (a thrown fetch error,
 *   or a response naming the close) — the bug reproduced. A close only
 *   happens during the boot window, so it alone proves the touch reached a
 *   cold start; no further evidence is needed.
 * - the target answered (any real HTTP response, not a connection error) and
 *   the deployment's own boot log confirms the touch was sent before the
 *   server finished booting — the edge held the connection through a real
 *   cold start. Genuine evidence toward "fixed".
 * - the target answered before there was anything left to boot through — no
 *   cold start happened, so the touch says nothing about the bug either way.
 * - the log evidence can't place the touch on either side of the boot (read
 *   cut off, or within the clock-skew margin) — inconclusive, not guessed.
 *
 * "The target answered" deliberately covers more than a successful RPC
 * result. This canary cannot supply the real per-edge Authorization bearer
 * key ADR-0030/0031 mints for the storefront -> auth wiring: the Management
 * API's own contract states plainly that an environment variable's value "is
 * stored encrypted and is not returned by subsequent reads" — verified live
 * against a real deploy, where an unauthenticated touch got back exactly
 * `401 {"error":"Unauthorized: missing or invalid service key"}` from a warm
 * instance. That 401 is `serve()`'s own documented rejection
 * (packages/0-framework/2-authoring/service-rpc/src/serve.ts) for a request
 * that never had a chance to supply a key this script cannot obtain — not a
 * sign PRO-217 fired. The property this canary needs from a "held" touch is
 * "the ingress carried the request through to the application", and a 401
 * proves exactly that as cleanly as a 2xx would: `serve()`'s accepted-key
 * check runs after the connection is already established, so reaching it at
 * all means the ingress did not reset the connection. Observed 401 latencies
 * during this canary's build (983-1102ms) track normal boot-racing latency,
 * not the ~400ms fast-fail PRO-217's close produces — further evidence this
 * is the auth check running on an already-live connection, not the close.
 * Any OTHER status or body is left `other` rather than folded in: a genuine
 * application bug must not silently count as proof the platform is healthy.
 */

/**
 * A raw, unauthenticated single-attempt `fetch` hitting the RPC endpoint
 * directly surfaces PRO-217 as a thrown error (Bun's `fetch` reports "The
 * socket connection was closed unexpectedly" for a reset), not as a 502 —
 * that shape only came from the streams canary's intermediary `jobs` caller
 * catching the error itself and wrapping it into a response body. Both
 * shapes are checked here for the same fragments regardless, since it costs
 * nothing and guards against the platform's exact behavior differing across
 * targets. Keep in sync with gotchas.md's PRO-217 entry.
 */
const CLOSE_FRAGMENTS = [
  'socket connection was closed',
  'econnreset',
  'econnrefused',
  'socket hang up',
];

/** One first-touch outcome against a freshly promoted `auth.service` instance. */
export type RpcColdStartTouch = 'held' | 'closed' | 'no-cold-start' | 'other';

/**
 * The caller's answer to "did this touch actually race a boot?", decided by
 * `classifyBootEvidence` from the deployment's own logs before
 * `classifyRpcColdStartTouch` is called. Identical three-way split to
 * cold-start-canary-classify.ts's `BootEvidence` — see that file for the
 * full reasoning; duplicated here (not imported) so this canary and its
 * gotchas paragraph can be deleted independently of the streams one.
 */
export type BootEvidence = 'confirmed-cold' | 'confirmed-warm' | 'unknown';

/**
 * `auth`'s own documented rejection for a request that never presented (or
 * presented the wrong) per-edge service key — see `serve()`'s accepted-keys
 * check. Matched verbatim so a coincidental, unrelated 401 does not get
 * folded into "the target answered".
 */
const UNAUTHORIZED_MISSING_KEY_MESSAGE = 'Unauthorized: missing or invalid service key';

/**
 * Whether `status`/`body` is a genuine application response — proof the
 * ingress carried the connection through to `serve()` — as opposed to a
 * connection-level failure or an unrelated error this canary should not
 * interpret either way. A real RPC success (2xx) counts; so does the
 * specific, known 401 this canary's own missing service key always produces
 * (see the module comment). Nothing else does — a 500 or an unexpected 4xx
 * is left uninterpreted rather than assumed harmless.
 */
function targetAnswered(status: number, body: string): boolean {
  if (status >= 200 && status < 300) return true;
  return status === 401 && body.includes(UNAUTHORIZED_MISSING_KEY_MESSAGE);
}

/**
 * Classifies one first-touch outcome from the CALLER's seat. `body` is
 * either a response body (fetch resolved) or the stringified error a thrown
 * fetch rejection produced (connection-level failure) — the caller passes
 * whichever it got, and `wasThrown` says which.
 *
 * A close is decisive regardless of `bootEvidence`: it only happens
 * mid-boot, so it is its own proof. A response that reaches `serve()`
 * (`targetAnswered`) only becomes `held` when `bootEvidence` is
 * `confirmed-cold`; `confirmed-warm` makes it `no-cold-start` (the touch
 * proves nothing, because nothing was booting when it landed), and `unknown`
 * makes it `other`. A thrown error that isn't a close, or a response that
 * isn't `targetAnswered`, is `other` either way.
 */
export function classifyRpcColdStartTouch(
  status: number,
  body: string,
  wasThrown: boolean,
  bootEvidence: BootEvidence,
): RpcColdStartTouch {
  const lower = body.toLowerCase();
  if (CLOSE_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return 'closed';
  }
  if (!wasThrown && targetAnswered(status, body)) {
    if (bootEvidence === 'confirmed-cold') return 'held';
    if (bootEvidence === 'confirmed-warm') return 'no-cold-start';
    return 'other';
  }
  return 'other';
}

/**
 * Strips ANSI SGR color codes from spark's boot log lines. The `auth`
 * service's own listening line (added for this canary — see
 * examples/storefront-auth/modules/auth/src/server.ts) is not colorized,
 * but spark's surrounding platform lines are, and stripping first keeps the
 * timestamp regex robust regardless of what shares the log stream. Built
 * from String.fromCharCode rather than a regex literal containing the raw
 * ESC byte, which Biome's noControlCharactersInRegex rule (rightly) rejects.
 */
export function stripAnsiCodes(text: string): string {
  const ESC = String.fromCharCode(27);
  return text.split(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')).join('');
}

/**
 * `auth`'s own boot line — e.g. "[2026-07-20T14:45:51.926Z] [INFO] auth
 * server listening on 0.0.0.0:3000" — read from a deployment's log history
 * (`?from_start=true`). Compute's log relay passes plain app stdout through
 * unmodified (verified live: an unstamped line arrives with no timestamp of
 * its own), so the timestamp is the app's own — stamped in server.ts rather
 * than left to the platform, unlike @prisma/streams-server's console.log
 * patch. Returns the timestamp it logged, or undefined if the boot never
 * reached it (or the log read didn't cover it).
 */
export function findListeningTimestamp(logText: string): Date | undefined {
  const match = stripAnsiCodes(logText).match(
    /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)]\s*\[INFO]\s*auth server listening/,
  );
  const timestamp = match?.[1];
  return timestamp !== undefined ? new Date(timestamp) : undefined;
}

/**
 * `touchSentAt` is `new Date()` on the CI runner; `listeningAt` is parsed out
 * of a timestamp `auth`'s own server.ts wrote with its own `new Date()` on a
 * Prisma Compute VM. Nothing keeps those two clocks in lockstep, so a
 * touch/listening gap of a few tens or hundreds of milliseconds is not by
 * itself proof of ordering — it could be clock skew rather than a genuine
 * race. Same margin and reasoning as cold-start-canary-classify.ts's
 * CLOCK_SKEW_MARGIN_MS: two well-behaved NTP-synced hosts are not expected
 * to disagree by more than a few hundred milliseconds, and 2 seconds is a
 * comfortable multiple of that while staying small next to the 3-22s boot
 * windows this family of canaries samples.
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
export type RpcColdStartVerdict = 'bug-present' | 'bug-gone' | 'inconclusive';

export interface RpcColdStartResult {
  readonly verdict: RpcColdStartVerdict;
  readonly message: string;
}

/**
 * Same target close rate as cold-start-canary-classify.ts's
 * TARGET_CLOSE_RATE, and the same reasoning: deliberately conservative
 * relative to the 60-100% close rates manual reproduction has actually
 * observed for this family of bug, so the sample budget below stays
 * trustworthy even if the RPC face's real defect rate is lower than the
 * streams face's.
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
 * The number of confirmed cold-start holds classifyRpcColdStartRun requires
 * before it will say bug-gone. Identical arithmetic to
 * cold-start-canary-classify.ts's MIN_HELD_SAMPLES_FOR_BUG_GONE:
 *
 *   0.8^13 ≈ 5.50% (not low enough)
 *   0.8^14 ≈ 4.40% (first N at or below 5%)
 *
 * so N = 14.
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
export function classifyRpcColdStartRun(touches: readonly RpcColdStartTouch[]): RpcColdStartResult {
  const n = touches.length;
  if (n === 0) return { verdict: 'inconclusive', message: 'Canary made no touches — broken.' };
  const count = (t: RpcColdStartTouch) => touches.filter((x) => x === t).length;
  const closed = count('closed');
  const held = count('held');
  const noColdStart = count('no-cold-start');
  const other = count('other');

  if (closed > 0) {
    return {
      verdict: 'bug-present',
      message:
        `Cold-start close still present on the service-RPC edge (${closed}/${n} first touches ` +
        `closed, ${held} held, ${noColdStart} never went cold) — PRO-217 not fixed; keep the ` +
        'bounded retry over keyed calls in service-rpc (client.ts/serve.ts) — that is permanent ' +
        'protocol semantics for this kind, not a compensation for this bug.',
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
        `reproduction against the streams face of this bug), the chance that ${held} independent ` +
        `cold starts would all happen to hold is ${asPercent(chanceAllHoldByLuck(held))}. This run ` +
        `needs at least ${MIN_HELD_SAMPLES_FOR_BUG_GONE} confirmed cold-start holds before an ` +
        `all-held result drops that chance to ${asPercent(MAX_FALSE_CLEAN_PROBABILITY)} or below ` +
        `(0.8^${MIN_HELD_SAMPLES_FOR_BUG_GONE} ≈ ` +
        `${asPercent(chanceAllHoldByLuck(MIN_HELD_SAMPLES_FOR_BUG_GONE))}). Not blocking.`,
    };
  }

  return {
    verdict: 'bug-gone',
    message:
      `All ${n} first touches against genuinely fresh, still-booting instances were held to ` +
      `success — ${held} confirmed cold-start holds with zero closes. Even at a conservative 20% ` +
      'close rate (well below the 60-100% close rates seen in manual reproduction against the ' +
      'streams face of this bug), the chance of that happening by luck alone is only ' +
      `${asPercent(chanceAllHoldByLuck(held))}, so this counts as real evidence: the platform no ` +
      "longer resets a service-RPC edge's first-touch connection during a cold start. To fix this " +
      'build (you are seeing it because the cleanup is now due, not because of your change): ' +
      '1) remove scripts/rpc-cold-start-canary.ts, scripts/rpc-cold-start-canary-classify.ts (+ ' +
      'its test) and the "RPC cold-start canary (PRO-217)" job in .github/workflows/e2e-deploy.yml; ' +
      "2) drop the service-RPC paragraph from gotchas.md's PRO-217 entry; 3) do NOT remove the " +
      "Idempotency-Key protocol or the bounded retry in service-rpc's client.ts/serve.ts — those " +
      'are permanent protocol semantics for this kind (safe retries on every call), not a PRO-217 ' +
      'compensation, and stay regardless of this verdict.',
  };
}
