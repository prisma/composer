import { describe, expect, test } from 'bun:test';
import { defineSchedule, parseEvery } from '../schedule.ts';

describe('defineSchedule()', () => {
  test('maps a job-id → interval spec to a jobs list, preserving key order', () => {
    const schedule = defineSchedule({ tick: '60s', mrr: '24h' });

    expect(schedule.jobs).toEqual([
      { jobId: 'tick', every: '60s' },
      { jobId: 'mrr', every: '24h' },
    ]);
  });

  test('an empty spec yields an empty jobs list', () => {
    expect(defineSchedule({}).jobs).toEqual([]);
  });
});

describe('parseEvery()', () => {
  test('parses "30s" as 30000 ms', () => {
    expect(parseEvery('30s')).toBe(30_000);
  });

  test('parses "5m" as 300000 ms', () => {
    expect(parseEvery('5m')).toBe(300_000);
  });

  test('parses "24h" as 86400000 ms', () => {
    expect(parseEvery('24h')).toBe(86_400_000);
  });

  test('parses "2d" as 172800000 ms', () => {
    expect(parseEvery('2d')).toBe(172_800_000);
  });

  test('throws on an empty string', () => {
    expect(() => parseEvery('')).toThrow();
  });

  test('throws when the unit is missing', () => {
    expect(() => parseEvery('60')).toThrow();
  });

  test('throws on an unknown unit', () => {
    expect(() => parseEvery('10x')).toThrow();
  });

  test('throws on a non-numeric value', () => {
    expect(() => parseEvery('abc')).toThrow();
  });

  test('throws on a zero value', () => {
    expect(() => parseEvery('0s')).toThrow();
  });

  test('throws on a negative value', () => {
    expect(() => parseEvery('-5s')).toThrow();
  });
});
