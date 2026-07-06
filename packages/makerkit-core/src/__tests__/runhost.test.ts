import { describe, expect, test } from "bun:test";
import { LoadError } from "../graph.ts";
import { resource, service } from "../node.ts";
import { ConfigError, runHost } from "../runtime.ts";
import { conn, memoryAdapter, untouchableAdapter } from "./helpers.ts";

const dbNode = (record?: (values: { url: string }) => void) =>
  resource({
    type: "fake/db",
    connection: conn({ url: { type: "string", secret: true } }, (v) => {
      record?.(v);
      return { client: v.url };
    }),
  });

const portParams = { port: { type: "number", default: 3000 } } as const;

describe("runHost", () => {
  test("resolves via the node's adapter, hydrates typed values, passes service params as ctx", async () => {
    let received: unknown;
    let ctx: unknown;
    const root = service({
      type: "fake/app",
      inputs: { db: dbNode() },
      params: portParams,
      config: memoryAdapter({ "db.url": "postgres://x", port: "8080" }),
      handler: (deps, c) => {
        received = deps;
        ctx = c;
        return "served";
      },
    });

    const result = await runHost(root);

    expect(result).toBe("served");
    expect(received).toEqual({ db: { client: "postgres://x" } });
    expect(ctx).toEqual({ port: 8080 });
  });

  test("opts.adapter swaps the platform adapter entirely", async () => {
    let ctx: unknown;
    const root = service({
      type: "fake/app",
      inputs: { db: dbNode() },
      params: portParams,
      config: untouchableAdapter, // the "platform" — must not be consulted
      handler: (_deps, c) => {
        ctx = c;
        return null;
      },
    });

    await runHost(root, { config: memoryAdapter({ "db.url": "postgres://swap", port: "4001" }) });

    expect(ctx).toEqual({ port: 4001 });
  });

  test("per-param overrides are applied BEFORE the adapter is consulted", async () => {
    const adapter = memoryAdapter({ "db.url": "postgres://from-adapter", port: "1111" });
    let received: unknown;
    let ctx: unknown;
    const root = service({
      type: "fake/app",
      inputs: { db: dbNode() },
      params: portParams,
      config: adapter,
      handler: (deps, c) => {
        received = deps;
        ctx = c;
        return null;
      },
    });

    await runHost(root, { overrides: { "db.url": "postgres://override", port: 2222 } });

    expect(received).toEqual({ db: { client: "postgres://override" } });
    expect(ctx).toEqual({ port: 2222 });
    // Overridden params were never requested from the adapter.
    expect(adapter.requested).toEqual([]);
  });

  test("adapter value beats declared default", async () => {
    let ctx: unknown;
    const root = service({
      type: "fake/app",
      inputs: {},
      params: portParams,
      config: memoryAdapter({ port: "9000" }),
      handler: (_deps, c) => {
        ctx = c;
        return null;
      },
    });

    await runHost(root);

    expect(ctx).toEqual({ port: 9000 });
  });

  test("full override set boots without the adapter returning anything", async () => {
    let received: unknown;
    const root = service({
      type: "fake/app",
      inputs: { db: dbNode() },
      params: {},
      config: untouchableAdapter,
      handler: (deps) => {
        received = deps;
        return null;
      },
    });

    await runHost(root, { overrides: { "db.url": "postgres://test" } });

    expect(received).toEqual({ db: { client: "postgres://test" } });
  });

  test("ConfigError names EVERY missing/invalid param at once, before any hydrate", async () => {
    let hydrateCalls = 0;
    const root = service({
      type: "fake/app",
      inputs: {
        db: resource({
          type: "fake/db",
          connection: conn({ url: { type: "string" } }, () => {
            hydrateCalls += 1;
            return {};
          }),
        }),
        cache: resource({
          type: "fake/cache",
          connection: conn({ url: { type: "string" } }, () => {
            hydrateCalls += 1;
            return {};
          }),
        }),
      },
      params: { replicas: { type: "number" } },
      config: memoryAdapter({ replicas: "not-a-number" }),
      handler: () => null,
    });

    expect(runHost(root)).rejects.toThrow(ConfigError);
    try {
      await runHost(root);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("db.url");
      expect(message).toContain("cache.url");
      expect(message).toContain("replicas");
    }
    expect(hydrateCalls).toBe(0);
  });

  test('R4-F2 probe: "" with a default resolves to the default (PORT="" → 3000, not 0)', async () => {
    let ctx: unknown;
    const root = service({
      type: "fake/app",
      inputs: {},
      params: portParams,
      config: memoryAdapter({ port: "" }),
      handler: (_deps, c) => {
        ctx = c;
        return null;
      },
    });

    await runHost(root);

    expect(ctx).toEqual({ port: 3000 });
  });

  test("R4-F2 probe: non-numeric with no default is a ConfigError naming the param", async () => {
    const root = service({
      type: "fake/app",
      inputs: {},
      params: { port: { type: "number" } },
      config: memoryAdapter({ port: "not-a-number" }),
      handler: () => null,
    });

    expect(runHost(root)).rejects.toThrow(ConfigError);
    expect(runHost(root)).rejects.toThrow(/port/);
  });

  test("R5-F1: garbage never defaults — non-numeric WITH a default is still a ConfigError", async () => {
    const root = service({
      type: "fake/app",
      inputs: {},
      params: portParams, // default 3000
      config: memoryAdapter({ port: "80O0" }),
      handler: () => null,
    });

    expect(runHost(root)).rejects.toThrow(ConfigError);
    expect(runHost(root)).rejects.toThrow(/port/);
  });

  test("R5: an unknown override key is an error in the same ConfigError — no silent fall-through", async () => {
    let handlerCalls = 0;
    const root = service({
      type: "fake/app",
      inputs: { db: dbNode() },
      params: {},
      config: memoryAdapter({ "db.url": "postgres://from-adapter" }),
      handler: () => {
        handlerCalls += 1;
        return null;
      },
    });

    // Typoed key: "db.ur1" instead of "db.url".
    expect(runHost(root, { overrides: { "db.ur1": "postgres://typo" } })).rejects.toThrow(ConfigError);
    expect(runHost(root, { overrides: { "db.ur1": "postgres://typo" } })).rejects.toThrow(/db\.ur1/);
    await runHost(root, { overrides: { "db.ur1": "postgres://typo" } }).catch(() => {});
    expect(handlerCalls).toBe(0);
  });

  test('"" is unresolved for a required string param too — loud boot error', async () => {
    const root = service({
      type: "fake/app",
      inputs: { db: dbNode() },
      params: {},
      config: memoryAdapter({ "db.url": "" }),
      handler: () => null,
    });

    expect(runHost(root)).rejects.toThrow(ConfigError);
    expect(runHost(root)).rejects.toThrow(/db\.url/);
  });

  test("optional param with no default resolves to undefined", async () => {
    const slices: unknown[] = [];
    const root = service({
      type: "fake/app",
      inputs: {
        db: resource({
          type: "fake/db",
          connection: conn(
            { url: { type: "string" }, schema: { type: "string", optional: true } },
            (v) => {
              slices.push(v);
              return {};
            },
          ),
        }),
      },
      params: {},
      config: memoryAdapter({ "db.url": "postgres://x" }),
      handler: () => null,
    });

    await runHost(root);

    expect(slices).toEqual([{ url: "postgres://x", schema: undefined }]);
  });

  test("async hydrate is awaited", async () => {
    let received: unknown;
    const root = service({
      type: "fake/app",
      inputs: {
        db: resource({
          type: "fake/db",
          connection: conn({ url: { type: "string" } }, async (v) => {
            await Promise.resolve();
            return { asyncClient: v.url };
          }),
        }),
      },
      params: {},
      config: memoryAdapter({ "db.url": "postgres://x" }),
      handler: (deps) => {
        received = deps;
        return null;
      },
    });

    await runHost(root);

    expect(received).toEqual({ db: { asyncClient: "postgres://x" } });
  });

  test("a dep-less service boots with zero declared config", async () => {
    let ctx: unknown;
    const root = service({
      type: "fake/app",
      inputs: {},
      params: portParams,
      config: memoryAdapter({}),
      handler: (_deps, c) => {
        ctx = c;
        return "booted";
      },
    });

    expect(await runHost(root)).toBe("booted");
    expect(ctx).toEqual({ port: 3000 });
  });

  test("Load runs first: a malformed graph fails with LoadError, nothing hydrates", async () => {
    const root = service({
      type: "fake/app",
      inputs: { db: { not: "a node" } as never },
      params: {},
      config: untouchableAdapter,
      handler: () => null,
    });

    expect(runHost(root, { overrides: { "db.url": "postgres://x" } })).rejects.toThrow(LoadError);
  });

  test("does not call the handler when config validation fails", async () => {
    let handlerCalls = 0;
    const root = service({
      type: "fake/app",
      inputs: { db: dbNode() },
      params: {},
      config: memoryAdapter({}),
      handler: () => {
        handlerCalls += 1;
        return null;
      },
    });

    expect(runHost(root)).rejects.toThrow(ConfigError);
    await runHost(root).catch(() => {});
    expect(handlerCalls).toBe(0);
  });
});
