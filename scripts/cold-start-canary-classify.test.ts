import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ColdStartTouch,
  classifyColdStartRun,
  classifyColdStartTouch,
} from './cold-start-canary-classify.ts';

describe('classifyColdStartTouch', () => {
  it('a 201 append → held (the edge carried the request through the boot)', () => {
    assert.equal(classifyColdStartTouch(201, '{"appended":{"n":1}}'), 'held');
  });

  it("the jobs service's surfaced close → closed (the PRO-217 signal)", () => {
    assert.equal(
      classifyColdStartTouch(
        502,
        'streams unreachable: Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true`',
      ),
      'closed',
    );
  });

  it('reset/refused faces of the same close → closed', () => {
    for (const body of ['ECONNRESET while fetching', 'connect ECONNREFUSED', 'socket hang up']) {
      assert.equal(classifyColdStartTouch(502, body), 'closed', body);
    }
  });

  it('a 502 whose cause is something else → other (inconclusive, not a close)', () => {
    assert.equal(classifyColdStartTouch(502, 'append failed: 500'), 'other');
  });

  it('any other status → other', () => {
    assert.equal(classifyColdStartTouch(500, 'boom'), 'other');
    assert.equal(classifyColdStartTouch(404, 'not found'), 'other');
    assert.equal(classifyColdStartTouch(200, 'ok but not an append'), 'other');
  });
});

describe('classifyColdStartRun (the three-exit mapping of a REQUIRED check)', () => {
  const run = (...touches: ColdStartTouch[]) => classifyColdStartRun(touches);

  it('no touches → inconclusive (broken canary; warn, do not block)', () => {
    assert.equal(run().verdict, 'inconclusive');
  });

  it("one close among holds → bug-present (exit 0; today's normal)", () => {
    const result = run('held', 'closed', 'held', 'held');
    assert.equal(result.verdict, 'bug-present');
    assert.match(result.message, /1\/4 first touches closed/);
    assert.match(result.message, /PRO-217 not fixed/);
  });

  it('all held → bug-gone (exit 1 — the forcing signal), actionable for a cold reader', () => {
    const result = run('held', 'held', 'held', 'held');
    assert.equal(result.verdict, 'bug-gone');
    assert.match(result.message, /not because of your change/);
    assert.match(result.message, /IDEMPOTENT_BACKOFF/);
    assert.match(result.message, /streams\/src\/client\.ts/);
    assert.match(result.message, /cold-start-canary\.ts/);
    assert.match(result.message, /e2e-deploy\.yml/);
    assert.match(result.message, /gotchas\.md/);
    assert.match(result.message, /PRO-219/);
  });

  it('no closes but not all held → inconclusive (exit 0 + warning), a human should look', () => {
    const result = run('held', 'other', 'held');
    assert.equal(result.verdict, 'inconclusive');
    assert.match(result.message, /not blocking/);
  });
});
