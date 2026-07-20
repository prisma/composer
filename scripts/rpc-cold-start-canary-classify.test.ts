import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLOCK_SKEW_MARGIN_MS,
  classifyBootEvidence,
  classifyRpcColdStartRun,
  classifyRpcColdStartTouch,
  findListeningTimestamp,
  MAX_FALSE_CLEAN_PROBABILITY,
  MIN_HELD_SAMPLES_FOR_BUG_GONE,
  type RpcColdStartTouch,
  stripAnsiCodes,
  TARGET_CLOSE_RATE,
} from './rpc-cold-start-canary-classify.ts';

describe('classifyRpcColdStartTouch', () => {
  it('a 200 confirmed cold → held (the edge carried the request through a real boot)', () => {
    assert.equal(classifyRpcColdStartTouch(200, '{"ok":true}', false, 'confirmed-cold'), 'held');
  });

  it("the canary's own known 401 (missing service key), confirmed cold → held — the ingress still carried it through", () => {
    const body = '{"error":"Unauthorized: missing or invalid service key"}';
    assert.equal(classifyRpcColdStartTouch(401, body, false, 'confirmed-cold'), 'held');
  });

  it('a 200 confirmed warm → no-cold-start (it proves nothing about PRO-217)', () => {
    assert.equal(
      classifyRpcColdStartTouch(200, '{"ok":true}', false, 'confirmed-warm'),
      'no-cold-start',
    );
  });

  it('the known 401, confirmed warm → no-cold-start', () => {
    const body = '{"error":"Unauthorized: missing or invalid service key"}';
    assert.equal(classifyRpcColdStartTouch(401, body, false, 'confirmed-warm'), 'no-cold-start');
  });

  it('a 200 with unknown boot evidence → other (log read failed or too close to call — not a guess)', () => {
    assert.equal(classifyRpcColdStartTouch(200, '{"ok":true}', false, 'unknown'), 'other');
  });

  it('a thrown fetch error naming the close → closed (the PRO-217 signal), regardless of boot evidence', () => {
    const message = 'fetch failed: The socket connection was closed unexpectedly';
    assert.equal(classifyRpcColdStartTouch(0, message, true, 'confirmed-cold'), 'closed');
    assert.equal(classifyRpcColdStartTouch(0, message, true, 'unknown'), 'closed');
  });

  it('reset/refused faces of the same close → closed, whether thrown or answered', () => {
    for (const body of ['ECONNRESET while fetching', 'connect ECONNREFUSED', 'socket hang up']) {
      assert.equal(classifyRpcColdStartTouch(0, body, true, 'unknown'), 'closed', body);
      assert.equal(classifyRpcColdStartTouch(502, body, false, 'unknown'), 'closed', body);
    }
  });

  it('an unrelated 401 (a real caller bug, not the missing-key message) → other, not held', () => {
    const body = '{"error":"Unauthorized: something else entirely"}';
    assert.equal(classifyRpcColdStartTouch(401, body, false, 'confirmed-cold'), 'other');
  });

  it('a 500 → other, regardless of boot evidence — a real app bug must not count as proof the platform is healthy', () => {
    assert.equal(
      classifyRpcColdStartTouch(500, '{"error":"Internal server error"}', false, 'confirmed-cold'),
      'other',
    );
  });

  it('any other unexpected status → other', () => {
    assert.equal(classifyRpcColdStartTouch(404, 'not found', false, 'confirmed-cold'), 'other');
    assert.equal(classifyRpcColdStartTouch(413, 'too large', false, 'unknown'), 'other');
  });

  it('a thrown error that does not name a close → other, not closed', () => {
    assert.equal(
      classifyRpcColdStartTouch(0, 'TimeoutError: signal timed out', true, 'unknown'),
      'other',
    );
  });
});

describe('stripAnsiCodes', () => {
  it('removes SGR escape sequences from spark boot log lines', () => {
    const colorized = `${String.fromCharCode(27)}[90m[${String.fromCharCode(27)}[0m2026-07-20T14:45:51Z ${String.fromCharCode(27)}[32mINFO ${String.fromCharCode(27)}[0m spark::app_source${String.fromCharCode(27)}[90m]${String.fromCharCode(27)}[0m compute.manifest.json not found`;
    assert.equal(
      stripAnsiCodes(colorized),
      '[2026-07-20T14:45:51Z INFO  spark::app_source] compute.manifest.json not found',
    );
  });

  it('leaves plain text untouched', () => {
    assert.equal(stripAnsiCodes('[INFO] plain line, no escapes'), '[INFO] plain line, no escapes');
  });
});

describe('findListeningTimestamp', () => {
  it("reads auth's own listening line", () => {
    const log =
      'spark: starting bun with entrypoint: bootstrap.js\r\n' +
      '[2026-07-20T14:45:51.926Z] [INFO] auth server listening on 0.0.0.0:3000\r\n';
    const found = findListeningTimestamp(log);
    assert.ok(found);
    assert.equal(found?.toISOString(), '2026-07-20T14:45:51.926Z');
  });

  it('returns undefined when the log never reached a listening line (e.g. read cut off mid-boot)', () => {
    const log =
      'spark: starting bun with entrypoint: bootstrap.js\r\n' +
      'spark: time-sync maintenance child started\r\n';
    assert.equal(findListeningTimestamp(log), undefined);
  });

  it('returns undefined for an empty or unrelated log', () => {
    assert.equal(findListeningTimestamp(''), undefined);
    assert.equal(findListeningTimestamp('some other server started fine'), undefined);
  });

  it("does not match a differently-named service (e.g. the streams face's own listening line)", () => {
    const log =
      '[2026-07-20T14:45:51.926Z] [INFO] prisma-streams server listening on 0.0.0.0:3000\r\n';
    assert.equal(findListeningTimestamp(log), undefined);
  });
});

describe('classifyBootEvidence (margin-aware, cross-clock comparison)', () => {
  const listeningAt = new Date('2026-07-20T14:45:51.926Z');

  it('touch sent comfortably before listening (beyond the skew margin) → confirmed-cold', () => {
    const touchSentAt = new Date(listeningAt.getTime() - CLOCK_SKEW_MARGIN_MS - 1);
    assert.equal(classifyBootEvidence(touchSentAt, listeningAt), 'confirmed-cold');
  });

  it('touch sent exactly at the margin boundary before listening → confirmed-cold (>=)', () => {
    const touchSentAt = new Date(listeningAt.getTime() - CLOCK_SKEW_MARGIN_MS);
    assert.equal(classifyBootEvidence(touchSentAt, listeningAt), 'confirmed-cold');
  });

  it('touch sent comfortably after listening (beyond the skew margin) → confirmed-warm', () => {
    const touchSentAt = new Date(listeningAt.getTime() + CLOCK_SKEW_MARGIN_MS + 1);
    assert.equal(classifyBootEvidence(touchSentAt, listeningAt), 'confirmed-warm');
  });

  it('touch sent within the skew margin on either side of listening → unknown (could be skew, not order)', () => {
    const justBefore = new Date(listeningAt.getTime() - CLOCK_SKEW_MARGIN_MS + 1);
    const justAfter = new Date(listeningAt.getTime() + CLOCK_SKEW_MARGIN_MS - 1);
    assert.equal(classifyBootEvidence(justBefore, listeningAt), 'unknown');
    assert.equal(classifyBootEvidence(justAfter, listeningAt), 'unknown');
  });

  it('no listening timestamp at all → unknown, not a guess', () => {
    assert.equal(classifyBootEvidence(new Date(), undefined), 'unknown');
  });
});

describe('the sample-budget arithmetic', () => {
  it('MIN_HELD_SAMPLES_FOR_BUG_GONE is the smallest N keeping an all-held run at or under 5% chance at a 20% close rate', () => {
    assert.equal(TARGET_CLOSE_RATE, 0.2);
    assert.equal(MAX_FALSE_CLEAN_PROBABILITY, 0.05);
    assert.equal(MIN_HELD_SAMPLES_FOR_BUG_GONE, 14);
    const chance = (n: number) => (1 - TARGET_CLOSE_RATE) ** n;
    assert.ok(chance(MIN_HELD_SAMPLES_FOR_BUG_GONE) <= MAX_FALSE_CLEAN_PROBABILITY);
    assert.ok(chance(MIN_HELD_SAMPLES_FOR_BUG_GONE - 1) > MAX_FALSE_CLEAN_PROBABILITY);
  });
});

describe('classifyRpcColdStartRun (the three-exit mapping of a REQUIRED check)', () => {
  const run = (...touches: RpcColdStartTouch[]) => classifyRpcColdStartRun(touches);
  const heldTimes = (n: number): RpcColdStartTouch[] => Array.from({ length: n }, () => 'held');

  it('no touches → inconclusive (broken canary; warn, do not block)', () => {
    assert.equal(run().verdict, 'inconclusive');
  });

  it("one close among holds → bug-present (exit 0; today's normal)", () => {
    const result = run('held', 'closed', 'held', 'held');
    assert.equal(result.verdict, 'bug-present');
    assert.match(result.message, /1\/4 first touches closed/);
    assert.match(result.message, /PRO-217 not fixed/);
    assert.match(result.message, /not a compensation/);
  });

  it('a close is decisive even alongside touches that never went cold', () => {
    const result = run('closed', 'no-cold-start', 'no-cold-start', 'no-cold-start');
    assert.equal(result.verdict, 'bug-present');
  });

  it('a close is decisive even in a run large enough to otherwise reach the bug-gone budget', () => {
    const result = classifyRpcColdStartRun([...heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE), 'closed']);
    assert.equal(result.verdict, 'bug-present');
  });

  it('all held but fewer than MIN_HELD_SAMPLES_FOR_BUG_GONE → inconclusive, not bug-gone (an all-held run this small is the expected outcome of an intermittent bug)', () => {
    const result = classifyRpcColdStartRun(heldTimes(4));
    assert.equal(result.verdict, 'inconclusive');
    assert.match(result.message, /All 4 confirmed cold-start touches held/);
    assert.match(result.message, /41\.0%/); // 0.8^4
    assert.match(result.message, new RegExp(String(MIN_HELD_SAMPLES_FOR_BUG_GONE)));
    assert.match(result.message, /not blocking/i);
  });

  it('all held at exactly MIN_HELD_SAMPLES_FOR_BUG_GONE → bug-gone (exit 1 — the forcing signal), actionable for a cold reader', () => {
    const result = classifyRpcColdStartRun(heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE));
    assert.equal(result.verdict, 'bug-gone');
    assert.match(result.message, /4\.4%/); // 0.8^14
    assert.match(result.message, /not because of your change/);
    assert.match(result.message, /rpc-cold-start-canary\.ts/);
    assert.match(result.message, /e2e-deploy\.yml/);
    assert.match(result.message, /gotchas\.md/);
    assert.match(result.message, /do NOT remove the Idempotency-Key protocol/);
  });

  it('one held short of the budget → inconclusive, not bug-gone', () => {
    const result = classifyRpcColdStartRun(heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE - 1));
    assert.equal(result.verdict, 'inconclusive');
  });

  it('any touch that never went cold makes the whole run inconclusive, even with no closes and plenty of holds', () => {
    const result = classifyRpcColdStartRun([
      ...heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE),
      'no-cold-start',
    ]);
    assert.equal(result.verdict, 'inconclusive');
    assert.match(result.message, /failed to force a cold start/);
    assert.match(result.message, /not blocking/);
  });

  it('all touches never going cold → inconclusive, not a clean bill of health', () => {
    const result = run('no-cold-start', 'no-cold-start', 'no-cold-start', 'no-cold-start');
    assert.equal(result.verdict, 'inconclusive');
    assert.match(result.message, /4\/4 touches/);
  });

  it('an "other" (broken/ambiguous) touch also blocks a bug-gone verdict', () => {
    const result = classifyRpcColdStartRun([...heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE), 'other']);
    assert.equal(result.verdict, 'inconclusive');
  });
});
