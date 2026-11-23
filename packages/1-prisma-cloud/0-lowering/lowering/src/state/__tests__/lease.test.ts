import { describe, expect, test } from 'bun:test';
import { serverErrorText } from '../lease.ts';

describe('serverErrorText', () => {
  test('passes the server message through, with the hint appended when there is one', () => {
    expect(
      serverErrorText({
        error: { message: 'the deploy lease is held by ada@host', hint: 'Retry.' },
      }),
    ).toBe('the deploy lease is held by ada@host Retry.');
    expect(serverErrorText({ error: { message: 'the deploy lease is held by ada@host' } })).toBe(
      'the deploy lease is held by ada@host',
    );
  });

  test('reports a 400 validation body, whose error is a list, as its JSON', () => {
    const body = {
      success: false,
      error: [{ path: ['stage'], message: 'Required' }],
      data: null,
    };
    expect(serverErrorText(body)).toBe(JSON.stringify(body));
  });
});
