import { describe, expect, test } from 'bun:test';
import { scopedEnvRows } from '../compute.ts';

/**
 * Local-dev spec § 4's pinned parity note: the hosted platform diffs a
 * deployment only on its own referenced rows, so an app-wide LOCAL
 * materialization restart-amplifies (an early-deployed service's snapshot
 * looks "changed" on the very next converge, purely from a sibling's row
 * landing afterward). `scopedEnvRows` is the fix — every service's
 * materialized env keeps only what it owns (`COMPOSER_<its address>_*`)
 * plus every row OUTSIDE the `COMPOSER_` namespace. Composer writes no
 * unprefixed row itself — an unprefixed name is a platform-owned one — but the
 * store is a plain file an operator can add to, and such a row is app-wide by
 * nature, so the scoping keeps it.
 */
describe('scopedEnvRows()', () => {
  test("keeps only the service's own COMPOSER_ rows plus every non-COMPOSER_ row", () => {
    const all = {
      COMPOSER_WEB_PORT: '3000',
      COMPOSER_WEB_ORIGIN: 'http://localhost:3000',
      COMPOSER_ORDERS_SERVICE_PORT: '3001',
      COMPOSER_ORDERS_SERVICE_CATALOG_URL: 'http://localhost:3002',
      SHARED_FEATURE_FLAG: 'on',
    };

    expect(scopedEnvRows(all, 'web')).toEqual({
      COMPOSER_WEB_PORT: '3000',
      COMPOSER_WEB_ORIGIN: 'http://localhost:3000',
      SHARED_FEATURE_FLAG: 'on',
    });
  });

  test('a nested address only matches its own dotted prefix, never a sibling module', () => {
    const all = {
      COMPOSER_ORDERS_SERVICE_PORT: '3001',
      // A DIFFERENT service under the same "orders" module — must not leak
      // into "orders.service"'s scoped env just because both start with
      // "COMPOSER_ORDERS_".
      COMPOSER_ORDERS_WORKER_PORT: '3005',
    };

    expect(scopedEnvRows(all, 'orders.service')).toEqual({
      COMPOSER_ORDERS_SERVICE_PORT: '3001',
    });
  });

  test('a service with no rows of its own still gets every app-wide row', () => {
    const all = {
      COMPOSER_OTHER_PORT: '4000',
      SHARED_FEATURE_FLAG: 'on',
    };

    expect(scopedEnvRows(all, 'web')).toEqual({ SHARED_FEATURE_FLAG: 'on' });
  });

  test('an empty env store scopes to an empty object', () => {
    expect(scopedEnvRows({}, 'web')).toEqual({});
  });

  test('an address that is a string-prefix of another address never matches its rows (underscore boundary)', () => {
    // "web" is a literal string prefix of "web2" — without the trailing
    // underscore on the match prefix, "web"'s scope would also swallow
    // "web2"'s own rows. COMPOSER_WEB_PORT vs COMPOSER_WEB2_PORT: the
    // prefix "COMPOSER_WEB_" (with its trailing underscore) does not match
    // "COMPOSER_WEB2_PORT" — the characters diverge at "WEB" + "_" vs "2".
    const all = {
      COMPOSER_WEB_PORT: '3000',
      COMPOSER_WEB2_PORT: '3001',
    };

    expect(scopedEnvRows(all, 'web')).toEqual({ COMPOSER_WEB_PORT: '3000' });
    expect(scopedEnvRows(all, 'web2')).toEqual({ COMPOSER_WEB2_PORT: '3001' });
  });
});
