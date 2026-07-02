import { describe, expect, test } from "bun:test";
import { Load, LoadError } from "../graph.ts";
import { resource, service } from "../node.ts";

describe("Load", () => {
  test("builds path-derived ids, edges, and topo-ordered nodes (deps first)", () => {
    const db = resource({ type: "fake/db" });
    const root = service({ type: "fake/app", inputs: { db }, handler: () => null });

    const graph = Load(root, { id: "hello" });

    expect(graph.root).toEqual({ id: "hello", node: root });
    expect(graph.nodes.map((n) => n.id)).toEqual(["hello.db", "hello"]);
    expect(graph.edges).toEqual([{ from: "hello.db", to: "hello", input: "db" }]);
  });

  test("defaults the root id to \"root\"", () => {
    const root = service({
      type: "fake/app",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: () => null,
    });

    const graph = Load(root);

    expect(graph.root.id).toBe("root");
    expect(graph.nodes.map((n) => n.id)).toEqual(["root.db", "root"]);
  });

  test("one graph node per input, root last", () => {
    const root = service({
      type: "fake/app",
      inputs: { a: resource({ type: "fake/db" }), b: resource({ type: "fake/cache" }) },
      handler: () => null,
    });

    const graph = Load(root, { id: "svc" });

    expect(graph.nodes.map((n) => n.id)).toEqual(["svc.a", "svc.b", "svc"]);
    expect(graph.edges).toEqual([
      { from: "svc.a", to: "svc", input: "a" },
      { from: "svc.b", to: "svc", input: "b" },
    ]);
  });

  test("executes nothing", () => {
    let calls = 0;
    const root = service({
      type: "fake/app",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: () => {
        calls += 1;
        return null;
      },
    });

    Load(root);

    expect(calls).toBe(0);
  });

  test("rejects a root that is not a branded service node", () => {
    expect(() => Load({} as never)).toThrow(LoadError);
    expect(() => Load(resource({ type: "fake/db" }) as never)).toThrow(LoadError);
  });

  test("rejects an input that is not a branded resource node", () => {
    const root = service({
      type: "fake/app",
      inputs: { db: { kind: "resource", type: "fake/db" } as never },
      handler: () => null,
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/db/);
  });

  test("rejects a forged input with an empty type", () => {
    // Spread copies the brand symbol but lets the type be emptied — Load must catch it.
    const forged = { ...resource({ type: "fake/db" }), type: "" };
    const root = service({
      type: "fake/app",
      inputs: { db: forged as never },
      handler: () => null,
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/empty node type/);
  });
});
