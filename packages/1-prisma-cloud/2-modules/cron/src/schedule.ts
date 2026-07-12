/**
 * A job-id → interval map, turned into the structured `jobs` list the
 * scheduler's param stores. The typed `Ids` carries the job ids for
 * `serveSchedule`'s exhaustiveness (a later dispatch).
 */
export interface Schedule<Ids extends string> {
  readonly jobs: ReadonlyArray<{ readonly jobId: Ids; readonly every: string }>;
}

/**
 * `defineSchedule({ tick: '60s', mrr: '24h' })` →
 * `{ jobs: [{ jobId: 'tick', every: '60s' }, { jobId: 'mrr', every: '24h' }] }`,
 * preserving key order.
 */
export function defineSchedule<const S extends Record<string, string>>(
  spec: S,
): Schedule<keyof S & string> {
  return {
    jobs: Object.entries(spec).map(([jobId, every]) => ({ jobId, every })),
  };
}

/**
 * Parses the `every` grammar `<integer><unit>`, unit one of `s`/`m`/`h`/`d`
 * (e.g. `30s`, `24h`), returning milliseconds. Throws on a malformed value —
 * empty, missing/unknown unit, non-integer, or non-positive.
 */
export function parseEvery(s: string): number {
  const match = /^(\d+)([smhd])$/.exec(s);
  if (match === null) {
    throw new Error(
      `parseEvery(): "${s}" is not a valid interval — expected "<integer><unit>" with unit one of s/m/h/d (e.g. "30s", "24h").`,
    );
  }

  const [, digits = '', unit = ''] = match;
  const value = Number(digits);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`parseEvery(): "${s}" must have a positive integer value.`);
  }

  switch (unit) {
    case 's':
      return value * 1_000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    default:
      throw new Error(
        `parseEvery(): "${s}" has an unknown unit "${unit}" — expected one of s/m/h/d.`,
      );
  }
}
