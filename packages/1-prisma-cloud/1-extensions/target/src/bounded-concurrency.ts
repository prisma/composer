/**
 * Runs `task` on every item with at most `limit` running at once, and keeps
 * the results in the items' order. The first failure rejects the whole call,
 * and no task starts after it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.entries();
  let failed = false;
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      if (failed) return;
      try {
        results[index] = await task(item);
      } catch (cause) {
        failed = true;
        throw cause;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
