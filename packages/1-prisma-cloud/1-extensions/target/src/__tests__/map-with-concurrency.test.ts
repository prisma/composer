import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from '../map-with-concurrency.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('mapWithConcurrency', () => {
  test('keeps the results in the order of the items, whatever order the tasks finish in', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms * 2;
    });

    expect(results).toEqual([60, 20, 40]);
  });

  test('never runs more than the limit at once', async () => {
    let running = 0;
    let most = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, index) => index),
      3,
      async () => {
        running += 1;
        most = Math.max(most, running);
        await tick();
        running -= 1;
      },
    );

    expect(most).toBe(3);
  });

  test('the first failure rejects the call, and no task starts after it', async () => {
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 1, async (item) => {
      started.push(item);
      await tick();
      if (item === 1) throw new Error('list failed');
    });

    await expect(run).rejects.toThrow('list failed');
    expect(started).toEqual([0, 1]);
  });

  test('no items gives no results', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });
});
