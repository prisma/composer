import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLOCK_SKEW_MARGIN_MS,
  type ColdStartTouch,
  classifyBootEvidence,
  classifyColdStartRun,
  classifyColdStartTouch,
  findListeningTimestamp,
  MAX_FALSE_CLEAN_PROBABILITY,
  MIN_HELD_SAMPLES_FOR_BUG_GONE,
  stripAnsiCodes,
  TARGET_CLOSE_RATE,
} from './cold-start-canary-classify.ts';

describe('classifyColdStartTouch', () => {
  it('a 201 confirmed cold → held (the edge carried the request through a real boot)', () => {
    assert.equal(classifyColdStartTouch(201, '{"appended":{"n":1}}', 'confirmed-cold'), 'held');
  });

  it('a 201 confirmed warm → no-cold-start (it proves nothing about PRO-217)', () => {
    assert.equal(
      classifyColdStartTouch(201, '{"appended":{"n":1}}', 'confirmed-warm'),
      'no-cold-start',
    );
  });

  it('a 201 with unknown boot evidence → other (log read failed or too close to call — not a guess)', () => {
    assert.equal(classifyColdStartTouch(201, '{"appended":{"n":1}}', 'unknown'), 'other');
  });

  it("the jobs service's surfaced close → closed (the PRO-217 signal), regardless of boot evidence", () => {
    const body =
      'streams unreachable: Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true`';
    assert.equal(classifyColdStartTouch(502, body, 'confirmed-cold'), 'closed');
    assert.equal(classifyColdStartTouch(502, body, 'unknown'), 'closed');
  });

  it('reset/refused faces of the same close → closed', () => {
    for (const body of ['ECONNRESET while fetching', 'connect ECONNREFUSED', 'socket hang up']) {
      assert.equal(classifyColdStartTouch(502, body, 'unknown'), 'closed', body);
    }
  });

  it('a 502 whose cause is something else → other (inconclusive, not a close)', () => {
    assert.equal(classifyColdStartTouch(502, 'append failed: 500', 'unknown'), 'other');
  });

  it('any other status → other, regardless of boot evidence', () => {
    assert.equal(classifyColdStartTouch(500, 'boom', 'confirmed-cold'), 'other');
    assert.equal(classifyColdStartTouch(404, 'not found', 'unknown'), 'other');
    assert.equal(classifyColdStartTouch(200, 'ok but not an append', 'confirmed-cold'), 'other');
  });
});

describe('stripAnsiCodes', () => {
  it('removes SGR escape sequences from spark boot log lines', () => {
    const colorized = `${String.fromCharCode(27)}[90m[${String.fromCharCode(27)}[0m2026-07-17T12:04:08Z ${String.fromCharCode(27)}[32mINFO ${String.fromCharCode(27)}[0m spark::app_source${String.fromCharCode(27)}[90m]${String.fromCharCode(27)}[0m compute.manifest.json not found`;
    assert.equal(
      stripAnsiCodes(colorized),
      '[2026-07-17T12:04:08Z INFO  spark::app_source] compute.manifest.json not found',
    );
  });

  it('leaves plain text untouched', () => {
    assert.equal(stripAnsiCodes('[INFO] plain line, no escapes'), '[INFO] plain line, no escapes');
  });
});

describe('findListeningTimestamp', () => {
  it("reads the streams server's own listening line", () => {
    const log =
      'streams: bootstrapping local state from the object store\r\n' +
      '[2026-07-17T12:04:10.313Z] [INFO] prisma-streams server listening on 0.0.0.0:3000\r\n';
    const found = findListeningTimestamp(log);
    assert.ok(found);
    assert.equal(found?.toISOString(), '2026-07-17T12:04:10.313Z');
  });

  it('returns undefined when the log never reached a listening line (e.g. read cut off mid-boot)', () => {
    const log =
      'spark: starting bun with entrypoint: bootstrap.js\r\n' +
      'streams: bootstrapping local state from the object store\r\n';
    assert.equal(findListeningTimestamp(log), undefined);
  });

  it('returns undefined for an empty or unrelated log', () => {
    assert.equal(findListeningTimestamp(''), undefined);
    assert.equal(findListeningTimestamp('some other server started fine'), undefined);
  });
});

describe('classifyBootEvidence (margin-aware, cross-clock comparison)', () => {
  const listeningAt = new Date('2026-07-17T12:04:10.000Z');

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

describe('classifyColdStartRun (the three-exit mapping of a REQUIRED check)', () => {
  const run = (...touches: ColdStartTouch[]) => classifyColdStartRun(touches);
  const heldTimes = (n: number): ColdStartTouch[] => Array.from({ length: n }, () => 'held');

  it('no touches → inconclusive (broken canary; warn, do not block)', () => {
    assert.equal(run().verdict, 'inconclusive');
  });

  it("one close among holds → bug-present (exit 0; today's normal)", () => {
    const result = run('held', 'closed', 'held', 'held');
    assert.equal(result.verdict, 'bug-present');
    assert.match(result.message, /1\/4 first touches closed/);
    assert.match(result.message, /PRO-217 not fixed/);
  });

  it('a close is decisive even alongside touches that never went cold', () => {
    const result = run('closed', 'no-cold-start', 'no-cold-start', 'no-cold-start');
    assert.equal(result.verdict, 'bug-present');
  });

  it('a close is decisive even in a run large enough to otherwise reach the bug-gone budget', () => {
    const result = classifyColdStartRun([...heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE), 'closed']);
    assert.equal(result.verdict, 'bug-present');
  });

  it('all held but fewer than MIN_HELD_SAMPLES_FOR_BUG_GONE → inconclusive, not bug-gone (an all-held run this small is the expected outcome of an intermittent bug)', () => {
    const result = classifyColdStartRun(heldTimes(4));
    assert.equal(result.verdict, 'inconclusive');
    assert.match(result.message, /All 4 confirmed cold-start touches held/);
    assert.match(result.message, /41\.0%/); // 0.8^4
    assert.match(result.message, new RegExp(String(MIN_HELD_SAMPLES_FOR_BUG_GONE)));
    assert.match(result.message, /not blocking/i);
  });

  it('all held at exactly MIN_HELD_SAMPLES_FOR_BUG_GONE → bug-gone (exit 1 — the forcing signal), actionable for a cold reader', () => {
    const result = classifyColdStartRun(heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE));
    assert.equal(result.verdict, 'bug-gone');
    assert.match(result.message, /4\.4%/); // 0.8^14
    assert.match(result.message, /not because of your change/);
    assert.match(result.message, /IDEMPOTENT_BACKOFF/);
    assert.match(result.message, /streams\/src\/client\.ts/);
    assert.match(result.message, /cold-start-canary\.ts/);
    assert.match(result.message, /e2e-deploy\.yml/);
    assert.match(result.message, /gotchas\.md/);
    assert.match(result.message, /PRO-219/);
  });

  it('one held short of the budget → inconclusive, not bug-gone', () => {
    const result = classifyColdStartRun(heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE - 1));
    assert.equal(result.verdict, 'inconclusive');
  });

  it('any touch that never went cold makes the whole run inconclusive, even with no closes and plenty of holds', () => {
    const result = classifyColdStartRun([
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
    const result = classifyColdStartRun([...heldTimes(MIN_HELD_SAMPLES_FOR_BUG_GONE), 'other']);
    assert.equal(result.verdict, 'inconclusive');
  });
});
