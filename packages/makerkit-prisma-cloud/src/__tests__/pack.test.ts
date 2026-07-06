import { describe, expect, test } from "bun:test";
import { configOf, isNode } from "@makerkit/core";
import type { ConfigAdapter, ConfigRequest } from "@makerkit/core";
import { ConfigError, runHost } from "@makerkit/core/runtime";
import { compute, postgres } from "../index.ts";

/** In-memory adapter keyed by param path — reads no environment. */
const memoryAdapter = (values: Record<string, string>): ConfigAdapter => ({
  async get(requests) {
    const out: Record<string, string> = {};
    for (const r of requests) {
      const path = r.owner === "service" ? r.name : `${r.owner.input}.${r.name}`;
      const value = values[path];
      if (value !== undefined) out[r.id] = value;
    }
    return out;
  },
});

describe("postgres({ client })", () => {
  test("returns a branded resource node declaring { url: string, secret }", () => {
    const node = postgres({ client: ({ url }) => ({ url }) });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe("resource");
    expect(node.type).toBe("prisma-cloud/postgres");
    expect(node.connection.params).toEqual({ url: { type: "string", secret: true } });
  });

  test("hydrate delegates to the app's client factory; C is inferred", async () => {
    const made: unknown[] = [];
    const node = postgres({
      client: (config) => {
        made.push(config);
        return { fake: "client", ...config };
      },
    });

    const client = await node.connection.hydrate({ url: "postgres://u:p@host:5432/db" });

    expect(made).toEqual([{ url: "postgres://u:p@host:5432/db" }]);
    expect(client).toEqual({ fake: "client", url: "postgres://u:p@host:5432/db" });
  });
});

describe("compute()", () => {
  test("returns a branded service node declaring { port: number, default 3000 } with the platform adapter", () => {
    const node = compute({}, () => null);

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe("service");
    expect(node.type).toBe("prisma-cloud/compute");
    expect(node.params).toEqual({ port: { type: "number", default: 3000 } });
    expect(typeof node.config.get).toBe("function");
    expect(typeof node.config.describe).toBe("function");
  });

  test("is inert until run", () => {
    let calls = 0;
    const db = postgres({ client: ({ url }) => ({ url }) });
    const node = compute({ db }, () => {
      calls += 1;
      return null;
    });

    expect(node.inputs.db).toBe(db);
    expect(calls).toBe(0);
  });
});

describe("the platform adapter (private mapping)", () => {
  const requestFor = (owner: ConfigRequest["owner"], name: string): ConfigRequest => ({
    id: `test:${name}`,
    owner,
    name,
    param: { type: "string" },
  });

  test("maps url ↔ DATABASE_URL and other params to their uppercased names", async () => {
    const node = compute({}, () => null);
    const previousUrl = process.env.DATABASE_URL;
    const previousPort = process.env.PORT;
    process.env.DATABASE_URL = "postgres://from-env";
    process.env.PORT = "7777";
    try {
      const values = await node.config.get([
        requestFor({ input: "db" }, "url"),
        requestFor("service", "port"),
      ]);
      expect(values).toEqual({ "test:url": "postgres://from-env", "test:port": "7777" });
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  });

  test("describe names the physical location without exposing it to core's manifest", async () => {
    const node = compute({}, () => null);

    expect(await node.config.describe?.(requestFor({ input: "db" }, "url"))).toEqual({
      location: "env:DATABASE_URL",
    });
    expect(await node.config.describe?.(requestFor("service", "port"))).toEqual({
      location: "env:PORT",
    });
  });
});

describe("importing a service module", () => {
  test("runs nothing (invariant 3)", async () => {
    const fixture = await import("./fixtures/side-effect-service.ts");

    expect(fixture.handlerCallCount).toBe(0);

    fixture.default.run({ db: { url: "x" } }, { port: 3000 });
    expect(fixture.handlerCallCount).toBe(1);
  });
});

describe("the config pipeline over pack nodes", () => {
  test("configOf is semantic — owner/name/type/secret, no platform keys", () => {
    const app = compute({ db: postgres({ client: ({ url }) => ({ url }) }) }, () => null);

    expect(configOf(app)).toEqual([
      { owner: { input: "db" }, name: "url", type: "string", secret: true, optional: false },
      { owner: "service", name: "port", type: "number", secret: false, optional: false, default: 3000 },
    ]);
    expect(JSON.stringify(configOf(app))).not.toContain("DATABASE_URL");
  });

  test("end to end with a swapped in-memory adapter", async () => {
    let received: unknown;
    let ctx: unknown;
    const app = compute(
      { db: postgres({ client: ({ url }) => ({ url }) }) },
      (deps, c) => {
        received = deps;
        ctx = c;
        return "served";
      },
    );

    const result = await runHost(app, {
      config: memoryAdapter({ "db.url": "postgres://x", port: "4001" }),
    });

    expect(result).toBe("served");
    expect(received).toEqual({ db: { url: "postgres://x" } });
    expect(ctx).toEqual({ port: 4001 });
  });

  test("per-param override boots with an empty adapter", async () => {
    let received: unknown;
    const app = compute(
      { db: postgres({ client: ({ url }) => ({ url }) }) },
      (deps) => {
        received = deps;
        return null;
      },
    );

    await runHost(app, { config: memoryAdapter({}), overrides: { "db.url": "postgres://test" } });

    expect(received).toEqual({ db: { url: "postgres://test" } });
  });

  test("a missing url is a ConfigError before the client factory runs", async () => {
    let factoryCalls = 0;
    const app = compute(
      {
        db: postgres({
          client: ({ url }) => {
            factoryCalls += 1;
            return { url };
          },
        }),
      },
      () => null,
    );

    expect(runHost(app, { config: memoryAdapter({}) })).rejects.toThrow(ConfigError);
    expect(runHost(app, { config: memoryAdapter({}) })).rejects.toThrow(/db\.url/);
    await runHost(app, { config: memoryAdapter({}) }).catch(() => {});
    expect(factoryCalls).toBe(0);
  });

  test("a dep-less service boots with zero declared config", async () => {
    let ctx: unknown;
    const app = compute({}, (_deps, c) => {
      ctx = c;
      return "booted";
    });

    expect(await runHost(app, { config: memoryAdapter({}) })).toBe("booted");
    expect(ctx).toEqual({ port: 3000 });
  });
});
