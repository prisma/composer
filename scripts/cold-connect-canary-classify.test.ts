import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ColdConnectSample,
  classifyColdConnectRun,
  classifyColdConnectSample,
  collectColdConnectSamples,
  MIN_BUG_GONE_SAMPLES,
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

  it('ALL of MIN_BUG_GONE_SAMPLES successes → bug-gone (exit 1 — the forcing signal), actionable for a cold reader', () => {
    const result = classifyColdConnectRun(
      Array.from({ length: MIN_BUG_GONE_SAMPLES }, () => 'success' as const),
    );
    assert.equal(result.verdict, 'bug-gone');
    assert.match(result.message, /not because of your change/);
    assert.match(result.message, /withConnectionRetry/);
    assert.match(result.message, /pg-connection\.ts/);
    assert.match(result.message, /cold-connect-canary\.ts/);
    assert.match(result.message, /e2e-deploy\.yml/);
  });

  it('a short all-success streak → inconclusive, NOT bug-gone (a lucky streak must not force removal)', () => {
    const result = run('success', 'success', 'success', 'success', 'success');
    assert.equal(result.verdict, 'inconclusive');
    assert.match(result.message, /luck/);
    assert.match(result.message, /keep withConnectionRetry/);
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

describe('collectColdConnectSamples', () => {
  /** A driver with a virtual clock, so spacing is asserted rather than waited out. */
  function driver(outcomes: ColdConnectSample[]) {
    const waits: number[] = [];
    const logs: string[] = [];
    let clock = 0;
    const run = (overrides: { minSamples?: number; maxRunMs?: number } = {}) =>
      collectColdConnectSamples({
        sample: (index) => {
          clock += 1_000; // each sample costs a second of the run's budget
          return Promise.resolve(outcomes[index] ?? 'success');
        },
        sleep: (ms) => {
          waits.push(ms);
          clock += ms;
          return Promise.resolve();
        },
        now: () => clock,
        minSamples: overrides.minSamples ?? 5,
        intervalMs: 60_000,
        maxRunMs: overrides.maxRunMs ?? 900_000,
        log: (line) => logs.push(line),
      });
    return { waits, logs, run };
  }

  it('never pauses before the first sample, and pauses once between each pair after', async () => {
    const d = driver(['success', 'success', 'success', 'success', 'timeout']);
    const samples = await d.run();
    assert.equal(samples.length, 5);
    // Four gaps between five samples — not five, which would mean a pointless
    // pause before the run had provisioned anything.
    assert.deepEqual(d.waits, [60_000, 60_000, 60_000, 60_000]);
  });

  it('stops at the first rejection without pausing again', async () => {
    const d = driver(['success', 'rejected', 'success']);
    const samples = await d.run();
    assert.deepEqual(samples, ['success', 'rejected']);
    assert.deepEqual(d.waits, [60_000]);
  });

  it('keeps sampling past minSamples while every sample succeeds, up to MIN_BUG_GONE_SAMPLES', async () => {
    const d = driver([]);
    const samples = await d.run();
    assert.equal(samples.length, MIN_BUG_GONE_SAMPLES);
    assert.ok(samples.every((s) => s === 'success'));
  });

  it('stops on the run budget rather than overrunning it, and that is not a bug-gone verdict', async () => {
    // 1s per sample + 60s per gap. A 200s budget covers samples at 0s, 61s,
    // 122s and 183s; a fifth would need a wait ending at 244s, past the
    // budget, so the loop must decline to start that wait rather than sample
    // on the far side of it.
    const d = driver([]);
    const samples = await d.run({ maxRunMs: 200_000 });
    assert.equal(samples.length, 4);
    assert.deepEqual(d.waits, [60_000, 60_000, 60_000]);
    assert.ok(d.logs.some((l) => l.includes('no room in the 200000ms budget')));
    // The reason stopping early is safe: it cannot manufacture the forcing signal.
    assert.equal(classifyColdConnectRun(samples).verdict, 'inconclusive');
  });
});
