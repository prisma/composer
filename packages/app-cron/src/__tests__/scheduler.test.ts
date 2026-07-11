import { describe, expect, spyOn, test } from 'bun:test';
import { runScheduler } from '../scheduler.ts';

interface FakeTimer {
  readonly fn: () => void;
  readonly ms: number;
}

function fakeSetTimer(): { setTimer: (fn: () => void, ms: number) => void; timers: FakeTimer[] } {
  const timers: FakeTimer[] = [];
  return { setTimer: (fn, ms) => timers.push({ fn, ms }), timers };
}

describe('runScheduler()', () => {
  test("registers one timer per job, at each job's parsed interval", () => {
    const { setTimer, timers } = fakeSetTimer();

    runScheduler({
      jobs: [
        { jobId: 'tick', every: '2s' },
        { jobId: 'mrr', every: '5s' },
      ],
      call: async () => undefined,
      setTimer,
    });

    expect(timers).toHaveLength(2);
    expect(timers[0]?.ms).toBe(2_000);
    expect(timers[1]?.ms).toBe(5_000);
  });

  test("invoking a registered timer calls call() with that job's id", () => {
    const { setTimer, timers } = fakeSetTimer();
    const calls: string[] = [];

    runScheduler({
      jobs: [{ jobId: 'tick', every: '1s' }],
      call: async (jobId) => {
        calls.push(jobId);
      },
      setTimer,
    });

    const timer = timers[0];
    if (timer === undefined) throw new Error('expected a timer to be registered');
    timer.fn();

    expect(calls).toEqual(['tick']);
  });

  test('a rejected call is logged, not thrown, and later ticks still fire', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { setTimer, timers } = fakeSetTimer();
      const calls: string[] = [];
      let failNextCall = true;

      runScheduler({
        jobs: [{ jobId: 'tick', every: '1s' }],
        call: async (jobId) => {
          calls.push(jobId);
          if (failNextCall) {
            failNextCall = false;
            throw new Error('boom');
          }
        },
        setTimer,
      });

      const timer = timers[0];
      if (timer === undefined) throw new Error('expected a timer to be registered');

      expect(() => timer.fn()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      timer.fn();
      await Promise.resolve();
      await Promise.resolve();

      expect(calls).toEqual(['tick', 'tick']);
      expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('omitting setTimer defaults to setInterval, at the parsed ms', () => {
    // spyOn calls through to the real setInterval; the pending timer is
    // harmless — bun test tears down the whole process per file, the same
    // no-close() teardown bootstrapService's own doc comment relies on.
    const intervalSpy = spyOn(globalThis, 'setInterval');
    try {
      runScheduler({
        jobs: [{ jobId: 'tick', every: '3s' }],
        call: async () => undefined,
      });

      expect(intervalSpy).toHaveBeenCalledTimes(1);
      const [, ms] = intervalSpy.mock.calls[0] ?? [];
      expect(ms).toBe(3_000);
    } finally {
      intervalSpy.mockRestore();
    }
  });
});
