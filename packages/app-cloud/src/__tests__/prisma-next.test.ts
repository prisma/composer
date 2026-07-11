/**
 * `pnPostgres()`'s runtime behavior — proven without a live database. The PN
 * client is lazy (its pool opens on first query), so hydrate is fully
 * exercisable here: `pnPostgresRuntime()` never connects just by being
 * constructed (see `fixtures/widget-contract/`'s round trip through the real
 * `prisma-next contract emit` CLI for the artifacts this suite imports).
 *
 * `pnContract<Contract>(contractJson)` pins the type parameter explicitly —
 * a JSON module import's inferred type is plain data, not the branded
 * `contract.d.ts` type, matching `@prisma-next/postgres/runtime`'s own
 * `postgres<Contract>({ contractJson })` convention (see prisma-next.ts).
 */
import { describe, expect, test } from 'bun:test';
import type { Contract } from '@prisma/app';
import { isNode, string } from '@prisma/app';
import { pnContract, pnPostgres } from '../prisma-next.ts';
import type { Contract as GadgetContract } from './fixtures/gadget-contract/emitted/contract.d.ts';
import gadgetContractJson from './fixtures/gadget-contract/emitted/contract.json' with {
  type: 'json',
};
import type { Contract as WidgetContract } from './fixtures/widget-contract/emitted/contract.d.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

describe('pnContract().satisfies()', () => {
  test('true when the required contract has the same storageHash', () => {
    const a = pnContract<WidgetContract>(widgetContractJson);
    const b = pnContract<WidgetContract>(widgetContractJson);
    expect(a.satisfies(b)).toBe(true);
    expect(b.satisfies(a)).toBe(true);
  });

  test('false when the required contract has a different storageHash', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const gadget = pnContract<GadgetContract>(gadgetContractJson);
    expect(widget.satisfies(gadget)).toBe(false);
    expect(gadget.satisfies(widget)).toBe(false);
  });

  test('false when the required contract carries a malformed __cmp (no contractJson)', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    // A prisma-next-kinded value whose __cmp lacks contractJson entirely —
    // storageHashOf() returns undefined, so satisfies() must be false rather
    // than throw or spuriously match.
    const malformed = {
      kind: 'prisma-next',
      __cmp: {},
      satisfies: () => false,
    } as Contract<'prisma-next', unknown>;
    expect(widget.satisfies(malformed)).toBe(false);
  });

  test("false in both directions when a wrapper's contractJson lacks storage.storageHash", () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    // contractJson is present but shaped wrong: no `storage.storageHash`.
    // Both this wrapper's own hash and any comparison against it resolve to
    // undefined, so satisfies() is false whichever side asks.
    const hashless = pnContract<WidgetContract>({ storage: { namespaces: {} } });
    expect(widget.satisfies(hashless)).toBe(false);
    expect(hashless.satisfies(widget)).toBe(false);
    // ...and a hashless wrapper does not even satisfy itself.
    expect(hashless.satisfies(hashless)).toBe(false);
  });

  test('the wrapped contract is frozen and carries the prisma-next kind', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    expect(widget.kind).toBe('prisma-next');
    expect(Object.isFrozen(widget)).toBe(true);
  });
});

describe('pnPostgres() factory shapes', () => {
  test('{ name, contract } yields a branded ResourceNode providing contract', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const node = pnPostgres({ name: 'database', contract: widget });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('resource');
    expect(node.name).toBe('database');
    expect(node.extension).toBe('@prisma/app-cloud');
    expect(node.type).toBe('prisma-next');
    expect(node.provides).toBe(widget);
  });

  test('pnPostgres(contract) yields a branded DependencyEnd requiring that contract', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const dep = pnPostgres(widget);

    expect(isNode(dep)).toBe(true);
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('prisma-next');
    expect(dep.required).toBe(widget);
    expect(Object.keys(dep.connection.params)).toEqual(['url']);
    expect(dep.connection.params['url']).toEqual(string({ secret: true }));
  });
});

describe('hydrate — no live database required (lazy pool)', () => {
  test('constructs a Prisma Next client from a fake url without connecting', async () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const dep = pnPostgres(widget);

    const client = await dep.connection.hydrate({
      url: 'postgres://user:pass@localhost:5432/does-not-exist',
    });

    // The PostgresClient surface — constructed synchronously; nothing here
    // implies a connection was opened (pool.connect() only happens on first
    // query/`.runtime()`/`.connect()` call, none of which this test makes).
    expect(typeof client.sql).toBe('object');
    expect(typeof client.orm).toBe('object');
    expect(typeof client.connect).toBe('function');
    expect(typeof client.runtime).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  test('hydrate does no schema verification — it just builds the client', () => {
    // There is no runtime marker check (ADR-0022): schema correctness is a
    // deploy-time job. Constructing the client can't be crashed by a marker
    // mismatch because hydrate sets no `verifyMarker` and reads no database.
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const dep = pnPostgres(widget);

    expect(() =>
      dep.connection.hydrate({ url: 'postgres://user:pass@localhost:5432/any-db' }),
    ).not.toThrow();
  });
});
