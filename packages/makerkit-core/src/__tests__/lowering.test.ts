import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { lowering, LowerError, type LowerOptions, type Target } from "../lower/index.ts";
import type { LoweredNode } from "../lower/index.ts";
import { resource, service } from "../node.ts";

const opts: LowerOptions = {
  name: "hello",
  artifact: { path: "/tmp/hello.tar.gz", sha256: "abc123" },
};

// The fake lowerings are pure, so the composable form runs synchronously.
const run = (eff: ReturnType<typeof lowering>): LoweredNode =>
  Effect.runSync(eff as Effect.Effect<LoweredNode, LowerError>);

const runError = (eff: ReturnType<typeof lowering>): LowerError =>
  Effect.runSync(Effect.flip(eff as Effect.Effect<LoweredNode, LowerError>));

function recordingTarget() {
  const calls: { id: string; type: string; loweredSoFar: string[] }[] = [];
  const target: Target = {
    name: "fake",
    providers: () => {
      throw new Error("providers() must not be called by lowering()");
    },
    lower: {
      "fake/db": (ctx) => {
        calls.push({ id: ctx.id, type: ctx.node.type, loweredSoFar: [...ctx.lowered.keys()] });
        return Effect.succeed({ outputs: { url: `db://${ctx.id}` } });
      },
      "fake/app": (ctx) => {
        calls.push({ id: ctx.id, type: ctx.node.type, loweredSoFar: [...ctx.lowered.keys()] });
        return Effect.succeed({ outputs: { url: `app://${ctx.id}` } });
      },
    },
  };
  return { target, calls };
}

describe("lowering", () => {
  test("routes each node through the target's table, deps before dependents", () => {
    const { target, calls } = recordingTarget();
    const root = service({
      type: "fake/app",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: () => null,
    });

    const result = run(lowering(root, target, opts));

    expect(calls.map((c) => c.id)).toEqual(["hello.db", "hello"]);
    // The dependent sees its dep already lowered.
    expect(calls[1].loweredSoFar).toEqual(["hello.db"]);
    // The root's LoweredNode is returned.
    expect(result).toEqual({ outputs: { url: "app://hello" } });
  });

  test("uses opts.name as the root node id", () => {
    const { target, calls } = recordingTarget();
    const root = service({
      type: "fake/app",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: () => null,
    });

    run(lowering(root, target, { ...opts, name: "acme" }));

    expect(calls.map((c) => c.id)).toEqual(["acme.db", "acme"]);
  });

  test("passes graph and opts through the LowerContext", () => {
    let seen: { graphRootId?: string; artifactPath?: string } = {};
    const target: Target = {
      name: "fake",
      providers: () => {
        throw new Error("unused");
      },
      lower: {
        "fake/app": (ctx) => {
          seen = { graphRootId: ctx.graph.root.id, artifactPath: ctx.opts.artifact.path };
          return Effect.succeed({ outputs: {} });
        },
      },
    };
    const root = service({ type: "fake/app", inputs: {}, handler: () => null });

    run(lowering(root, target, opts));

    expect(seen).toEqual({ graphRootId: "hello", artifactPath: "/tmp/hello.tar.gz" });
  });

  test("fails with LowerError naming the type and the known types on an unknown node type", () => {
    const { target } = recordingTarget();
    const root = service({
      type: "fake/unknown-kind",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: () => null,
    });

    const error = runError(lowering(root, target, opts));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain("fake/unknown-kind");
    expect(error.message).toContain("fake/db");
    expect(error.message).toContain("fake/app");
  });

  test("runs no handler", () => {
    let calls = 0;
    const { target } = recordingTarget();
    const root = service({
      type: "fake/app",
      inputs: { db: resource({ type: "fake/db" }) },
      handler: () => {
        calls += 1;
        return null;
      },
    });

    run(lowering(root, target, opts));

    expect(calls).toBe(0);
  });
});
