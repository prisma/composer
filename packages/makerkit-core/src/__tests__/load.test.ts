import { describe, expect, test } from "bun:test";
import { Load, LoadError } from "../graph.ts";
import { resource, service } from "../node.ts";
import { conn, memoryAdapter } from "./helpers.ts";

const adapter = memoryAdapter({});
const db = () => resource({ type: "fake/db", connection: conn({}, () => ({})) });
const app = (inputs: Record<string, ReturnType<typeof db>>) =>
  service({ type: "fake/app", inputs, params: {}, config: adapter, handler: () => null });

describe("Load", () => {
  test("builds path-derived ids, edges, and topo-ordered nodes (deps first)", () => {
    const input = db();
    const root = app({ db: input });

    const graph = Load(root, { id: "hello" });

    expect(graph.root).toEqual({ id: "hello", node: root });
    expect(graph.nodes.map((n) => n.id)).toEqual(["hello.db", "hello"]);
    expect(graph.edges).toEqual([{ from: "hello.db", to: "hello", input: "db" }]);
  });

  test("defaults the root id to \"root\"", () => {
    const graph = Load(app({ db: db() }));

    expect(graph.root.id).toBe("root");
    expect(graph.nodes.map((n) => n.id)).toEqual(["root.db", "root"]);
  });

  test("one graph node per input, root last", () => {
    const graph = Load(app({ a: db(), b: db() }), { id: "svc" });

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
      inputs: { db: db() },
      params: {},
      config: adapter,
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
    expect(() => Load(db() as never)).toThrow(LoadError);
  });

  test("rejects an input that is not a branded resource node", () => {
    const root = app({ db: { kind: "resource", type: "fake/db" } as never });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/db/);
  });

  test("rejects a forged input with an empty type", () => {
    // Spread copies the brand symbol but lets the type be emptied — Load must catch it.
    const forged = { ...db(), type: "" };
    const root = app({ db: forged as never });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/empty node type/);
  });
});
