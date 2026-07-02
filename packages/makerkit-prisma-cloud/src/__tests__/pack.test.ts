import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { isNode } from "@makerkit/core";
import { HydrateError, runHost } from "@makerkit/core/runtime";
import { compute, postgres } from "../index.ts";
import { prismaCloud } from "../target/index.ts";
import { runtime } from "../runtime/index.ts";

describe("postgres()", () => {
  test("returns a branded resource node with the pack's type id", () => {
    const node = postgres();

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe("resource");
    expect(node.type).toBe("prisma-cloud/postgres");
    expect(Object.isFrozen(node)).toBe(true);
  });
});

describe("compute()", () => {
  test("returns a branded service node wiring the deps, inert until run", () => {
    let calls = 0;
    const db = postgres();
    const node = compute({ db }, () => {
      calls += 1;
      return null;
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe("service");
    expect(node.type).toBe("prisma-cloud/compute");
    expect(node.inputs.db).toBe(db);
    expect(calls).toBe(0);
  });
});

describe("importing a service module", () => {
  test("runs nothing (invariant 3)", async () => {
    const fixture = await import("./fixtures/side-effect-service.ts");

    expect(fixture.handlerCallCount).toBe(0);

    fixture.default.run({ db: {} }, { port: 3000 });
    expect(fixture.handlerCallCount).toBe(1);
  });
});

describe("runtime()", () => {
  test("hydrates a postgres input by handing DATABASE_URL to the app's client factory", () => {
    const made: unknown[] = [];
    const rt = runtime({
      clients: {
        postgres: (config) => {
          made.push(config);
          return { fake: "client", ...config };
        },
      },
    });

    const client = rt.hydrate["prisma-cloud/postgres"]({
      id: "hello.db",
      input: "db",
      node: postgres(),
      env: { DATABASE_URL: "postgres://u:p@host:5432/db" },
    });

    expect(made).toEqual([{ url: "postgres://u:p@host:5432/db" }]);
    expect(client).toEqual({ fake: "client", url: "postgres://u:p@host:5432/db" });
  });

  test("throws HydrateError naming the input when DATABASE_URL is missing", () => {
    const rt = runtime({ clients: { postgres: () => ({}) } });

    expect(() =>
      rt.hydrate["prisma-cloud/postgres"]({ id: "hello.db", input: "db", node: postgres(), env: {} }),
    ).toThrow(HydrateError);
    expect(() =>
      rt.hydrate["prisma-cloud/postgres"]({ id: "hello.db", input: "db", node: postgres(), env: {} }),
    ).toThrow(/"db".*DATABASE_URL/);
  });

  test("context resolves PORT with a 3000 default", () => {
    const rt = runtime({ clients: { postgres: () => ({}) } });

    expect(rt.context({ PORT: "8080" })).toEqual({ port: 8080 });
    expect(rt.context({})).toEqual({ port: 3000 });
    expect(rt.context({ PORT: "not-a-number" })).toEqual({ port: 3000 });
  });

  test("end to end: runHost hydrates the client and passes the context", () => {
    let received: unknown;
    let ctx: unknown;
    const app = compute({ db: postgres<{ url: string }>() }, (deps, c) => {
      received = deps;
      ctx = c;
      return "served";
    });

    const result = runHost(
      app,
      runtime({ clients: { postgres: ({ url }) => ({ url }) } }),
      { DATABASE_URL: "postgres://x", PORT: "4001" },
    );

    expect(result).toBe("served");
    expect(received).toEqual({ db: { url: "postgres://x" } });
    expect(ctx).toEqual({ port: 4001 });
  });
});

describe("prismaCloud()", () => {
  test("declares the target name and a lowering per pack type id", () => {
    const target = prismaCloud({ workspaceId: "ws_123" });

    expect(target.name).toBe("prisma-cloud");
    expect(Object.keys(target.lower).sort()).toEqual([
      "prisma-cloud/compute",
      "prisma-cloud/postgres",
    ]);
    expect(typeof target.providers).toBe("function");
  });

  test("the postgres lowering provisions nothing and yields empty outputs", () => {
    const target = prismaCloud({ workspaceId: "ws_123" });

    const result = Effect.runSync(
      target.lower["prisma-cloud/postgres"]({
        id: "hello.db",
        node: postgres(),
        graph: undefined as never,
        opts: { name: "hello", artifact: { path: "/tmp/x.tar.gz", sha256: "abc" } },
        lowered: new Map(),
      }) as Effect.Effect<unknown>,
    );

    expect(result).toEqual({ outputs: {} });
  });
});
