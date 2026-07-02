import { describe, expect, test } from "bun:test";
import { LoadError } from "../graph.ts";
import { resource, service } from "../node.ts";
import { HydrateError, runHost, type TargetRuntime } from "../runtime/index.ts";

const fakeRuntime = (): TargetRuntime => ({
  context: (env) => ({ port: Number(env.PORT ?? 3000) }),
  hydrate: {
    "fake/db": ({ env, input }) => ({ client: `${input}:${env.DATABASE_URL}` }),
  },
});

describe("runHost", () => {
  test("hydrates each input via the runtime's table and calls the handler with deps + context", () => {
    let received: unknown;
    let ctxReceived: unknown;
    const root = service({
      type: "fake/app",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: (deps, ctx) => {
        received = deps;
        ctxReceived = ctx;
        return "served";
      },
    });

    const result = runHost(root, fakeRuntime(), { DATABASE_URL: "postgres://x", PORT: "8080" });

    expect(result).toBe("served");
    expect(received).toEqual({ db: { client: "db:postgres://x" } });
    expect(ctxReceived).toEqual({ port: 8080 });
  });

  test("hydrates one client per input, keyed by input name", () => {
    let received: Record<string, unknown> = {};
    const root = service({
      type: "fake/app",
      inputs: { primary: resource({ type: "fake/db" }), replica: resource({ type: "fake/db" }) },
      handler: (deps) => {
        received = deps as Record<string, unknown>;
        return null;
      },
    });

    runHost(root, fakeRuntime(), { DATABASE_URL: "postgres://x" });

    expect(Object.keys(received).sort()).toEqual(["primary", "replica"]);
  });

  test("Loads before hydrating: a malformed graph fails with LoadError and no hydrator runs", () => {
    let hydratorCalls = 0;
    const runtime: TargetRuntime = {
      context: () => ({ port: 3000 }),
      hydrate: {
        "fake/db": () => {
          hydratorCalls += 1;
          return {};
        },
      },
    };
    const root = service({
      type: "fake/app",
      inputs: { db: { not: "a node" } as never },
      handler: () => null,
    });

    expect(() => runHost(root, runtime, {})).toThrow(LoadError);
    expect(hydratorCalls).toBe(0);
  });

  test("throws HydrateError naming the type and known types on an unknown input type", () => {
    const root = service({
      type: "fake/app",
      inputs: { cache: resource({ type: "fake/redis" }) },
      handler: () => null,
    });

    expect(() => runHost(root, fakeRuntime(), {})).toThrow(HydrateError);
    expect(() => runHost(root, fakeRuntime(), {})).toThrow(/fake\/redis/);
    expect(() => runHost(root, fakeRuntime(), {})).toThrow(/fake\/db/);
  });

  test("does not call the handler when hydration fails", () => {
    let handlerCalls = 0;
    const root = service({
      type: "fake/app",
      inputs: { cache: resource({ type: "fake/redis" }) },
      handler: () => {
        handlerCalls += 1;
        return null;
      },
    });

    expect(() => runHost(root, fakeRuntime(), {})).toThrow(HydrateError);
    expect(handlerCalls).toBe(0);
  });
});
