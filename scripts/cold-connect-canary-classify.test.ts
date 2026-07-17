import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ColdConnectSample,
  classifyColdConnectRun,
  classifyColdConnectSample,
} from './cold-connect-canary-classify.ts';

describe('classifyColdConnectSample', () => {
  it('a successful connect (no error) → success', () => {
    assert.equal(classifyColdConnectSample(undefined), 'success');
  });

  it('the PPG cold-start upstream reject message → rejected', () => {
    assert.equal(
      classifyColdConnectSample(
        new Error('Failed to connect to upstream database. Please contact Prisma support'),
      ),
      'rejected',
    );
  });

  it('active-rejection socket codes → rejected', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']) {
      assert.equal(
        classifyColdConnectSample(Object.assign(new Error('x'), { code })),
        'rejected',
        code,
      );
    }
  });

  it('pool/server-close rejection messages → rejected', () => {
    for (const message of [
      'Connection terminated unexpectedly',
      'connection refused',
      'terminating connection due to administrator command',
      'server closed the connection unexpectedly',
    ]) {
      assert.equal(classifyColdConnectSample(new Error(message)), 'rejected', message);
    }
  });

  it('connect timeouts → timeout (not an active rejection)', () => {
    for (const error of [
      new Error('timeout expired'),
      new Error('Connection timeout'),
      Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
    ]) {
      assert.equal(classifyColdConnectSample(error), 'timeout');
    }
  });

  it('auth/quota errors → other (not assumed transient)', () => {
    assert.equal(
      classifyColdConnectSample(new Error('password authentication failed for user')),
      'other',
    );
    assert.equal(classifyColdConnectSample(new Error('quota exceeded')), 'other');
  });
});

describe("classifyColdConnectRun (unanimity, with a REQUIRED check's three exits)", () => {
  const run = (...s: ColdConnectSample[]) => classifyColdConnectRun(s);

  it('ANY rejection → bug-present (exit 0), even amid successes (a single rejection proves the bug)', () => {
    const result = run('success', 'success', 'rejected', 'success', 'success');
    assert.equal(result.verdict, 'bug-present');
    assert.match(result.message, /still present \(1\/5 rejected\)/);
  });

  it('ALL successes → bug-gone (exit 1 — the forcing signal), actionable for a cold reader', () => {
    const result = run('success', 'success', 'success', 'success', 'success');
    assert.equal(result.verdict, 'bug-gone');
    assert.match(result.message, /not because of your change/);
    assert.match(result.message, /withConnectionRetry/);
    assert.match(result.message, /pg-connection\.ts/);
    assert.match(result.message, /cold-connect-canary\.ts/);
    assert.match(result.message, /e2e-deploy\.yml/);
  });

  it('no rejections but not all-success (timeouts) → inconclusive (exit 0 + warning), not "fixed"', () => {
    const result = run('success', 'timeout', 'success', 'timeout', 'success');
    assert.equal(result.verdict, 'inconclusive');
    assert.match(result.message, /not blocking/);
  });

  it('a lone success does not flip a rejecting run to "fixed"', () => {
    assert.equal(run('rejected', 'rejected', 'success').verdict, 'bug-present');
  });

  it('zero samples → inconclusive (broken canary; warn, do not block)', () => {
    assert.equal(classifyColdConnectRun([]).verdict, 'inconclusive');
  });
});
