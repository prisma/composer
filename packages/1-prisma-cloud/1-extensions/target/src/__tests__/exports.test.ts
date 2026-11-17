import { expect, test } from 'bun:test';
import * as surface from '../exports/index.ts';

test('the package exports variable and no envSecret, envParam, secretName or paramName', () => {
  const names = Object.keys(surface);

  expect(names).toContain('variable');
  for (const removed of ['envSecret', 'envParam', 'secretName', 'paramName']) {
    expect(names).not.toContain(removed);
  }
});
