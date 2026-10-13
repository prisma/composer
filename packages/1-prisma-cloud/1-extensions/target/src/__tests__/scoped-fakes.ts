import { afterEach, beforeEach } from 'bun:test';

/**
 * bun's `mock.module` replaces a module for every test file in the run, not
 * just the file that calls it. A module mock built with the returned `fake`
 * uses the fake only while the calling file's own tests run, and the real
 * export otherwise, so tests in other files that use the real emulators
 * still get them.
 */
export function scopedFakes() {
  let active = false;
  beforeEach(() => {
    active = true;
  });
  afterEach(() => {
    active = false;
  });
  return <A extends unknown[], R>(real: (...args: A) => R, fake: (...args: A) => R) =>
    (...args: A): R =>
      active ? fake(...args) : real(...args);
}
