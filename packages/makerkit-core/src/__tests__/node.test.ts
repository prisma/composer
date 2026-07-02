import { describe, expect, test } from "bun:test";
import { isNode, resource, service } from "../node.ts";

describe("resource()", () => {
  test("returns a branded, frozen resource node", () => {
    const node = resource<{ q: () => string }>({ type: "fake/db" });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe("resource");
    expect(node.type).toBe("fake/db");
    expect(Object.isFrozen(node)).toBe(true);
  });

  test("carries config as data and freezes it", () => {
    const node = resource({ type: "fake/db", config: { size: 3 } });

    expect(node.config).toEqual({ size: 3 });
    expect(Object.isFrozen(node.config)).toBe(true);
  });

  test("throws on an empty type", () => {
    expect(() => resource({ type: "" })).toThrow(/non-empty node type/);
  });
});

describe("service()", () => {
  test("returns a branded, frozen service node with frozen inputs", () => {
    const db = resource({ type: "fake/db" });
    const node = service({ type: "fake/app", inputs: { db }, handler: () => null });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe("service");
    expect(node.type).toBe("fake/app");
    expect(node.inputs.db).toBe(db);
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.inputs)).toBe(true);
  });

  test("stores the handler as run; constructing calls nothing", () => {
    let calls = 0;
    const node = service({
      type: "fake/app",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: (deps, ctx) => {
        calls += 1;
        return { deps, ctx };
      },
    });

    expect(calls).toBe(0);

    const fakeDb = { q: 1 };
    const result = node.run({ db: fakeDb }, { port: 4242 });
    expect(calls).toBe(1);
    expect(result).toEqual({ deps: { db: fakeDb }, ctx: { port: 4242 } });
  });

  test("throws on an empty type", () => {
    expect(() => service({ type: "", inputs: {}, handler: () => null })).toThrow(
      /non-empty node type/,
    );
  });
});
