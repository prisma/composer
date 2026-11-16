import { expect, test } from 'bun:test';
import * as surface from '../exports/index.ts';

test('the package exports variable, paramName and no envSecret, envParam or secretName', () => {
  const names = Object.keys(surface);

  expect(names).toContain('variable');
  expect(names).toContain('paramName');
  for (const removed of ['envSecret', 'envParam', 'secretName']) {
    expect(names).not.toContain(removed);
  }
});
