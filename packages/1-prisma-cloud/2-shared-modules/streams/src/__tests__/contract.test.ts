import { describe, expect, test } from 'bun:test';
import { streamDef, streamsContract } from '../contract.ts';

describe('streamsContract(defs).satisfies', () => {
  test('accepts a contract of the same kind, regardless of its def map', () => {
    const jobs = streamsContract({ jobs: streamDef() });
    const other = {
      kind: 'streams' as const,
      __cmp: { audit: streamDef() },
      satisfies: () => true,
    };
    expect(jobs.satisfies(other)).toBe(true);
  });

  test('rejects a contract of a different kind', () => {
    const jobs = streamsContract({ jobs: streamDef() });
    // Cast is test-only: the mismatched kind literal is the point of the test.
    const other = {
      kind: 's3',
      __cmp: undefined,
      satisfies: () => true,
    } as unknown as Parameters<typeof jobs.satisfies>[0];
    expect(jobs.satisfies(other)).toBe(false);
  });

  test('carries the declared def map as __cmp', () => {
    const jobDef = streamDef();
    const auditDef = streamDef();
    const contract = streamsContract({ jobs: jobDef, audit: auditDef });
    expect(contract.__cmp).toEqual({ jobs: jobDef, audit: auditDef });
  });
});
