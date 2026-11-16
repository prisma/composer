import { describe, expect, test } from 'bun:test';
import { quotedList } from './quoted-list.ts';

describe('quotedList', () => {
  test('quotes one name', () => {
    expect(quotedList(['shop.a'])).toBe('"shop.a"');
  });

  test('joins two names with "and"', () => {
    expect(quotedList(['shop.a', 'shop.b'])).toBe('"shop.a" and "shop.b"');
  });

  test('separates three or more names with commas, and joins the last with "and"', () => {
    expect(quotedList(['shop.a', 'shop.b', 'shop.c'])).toBe('"shop.a", "shop.b" and "shop.c"');
  });
});
