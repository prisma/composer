import { describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { LoweredNode, LowerOptions } from "@makerkit/core/deploy";

// Stub the provider layer so the compute lowering's data flow (id derivation,
// props threading, outputs shape) runs purely — no Alchemy engine, no cloud.
const recorded: { project: unknown[]; svc: unknown[]; deploy: unknown[] } = {
  project: [],
  svc: [],
  deploy: [],
};

mock.module("@makerkit/prisma-alchemy", () => ({
  providers: () => ({ stub: "providers" }),
  Project: (id: string, props: unknown) => {
    recorded.project.push([id, props]);
    return Effect.succeed({ id: `${id}#cloud-id`, name: id });
  },
  ComputeService: (id: string, props: unknown) => {
    recorded.svc.push([id, props]);
    return Effect.succeed({ id: `${id}#cloud-id`, name: id });
  },
  Deployment: (id: string, props: unknown) => {
    recorded.deploy.push([id, props]);
    return Effect.succeed({ versionId: "v1", deployedUrl: "https://auth.example" });
  },
}));

const { prismaCloud } = await import("../target.ts");

const opts: LowerOptions = {
  name: "auth",
  artifact: { path: "/tmp/auth.tar.gz", sha256: "hash123" },
};

describe("prisma-cloud/compute lowering", () => {
  test("exposes url AND projectId in outputs, threading props through Project → ComputeService → Deployment", () => {
    const target = prismaCloud({ workspaceId: "ws_1" });

    const result = Effect.runSync(
      target.lower["prisma-cloud/compute"]({
        id: "auth",
        node: undefined as never,
        graph: undefined as never,
        opts,
        lowered: new Map(),
      }) as Effect.Effect<LoweredNode>,
    );

    expect(result.outputs).toEqual({
      url: "https://auth.example",
      projectId: "auth-project#cloud-id",
    });

    expect(recorded.project).toEqual([
      ["auth-project", { workspaceId: "ws_1", name: "auth" }],
    ]);
    expect(recorded.svc).toEqual([
      [
        "auth-svc",
        { projectId: "auth-project#cloud-id", name: "auth", region: "us-east-1" },
      ],
    ]);
    expect(recorded.deploy).toEqual([
      [
        "auth-deploy",
        {
          computeServiceId: "auth-svc#cloud-id",
          artifactPath: "/tmp/auth.tar.gz",
          artifactHash: "hash123",
          port: 3000,
        },
      ],
    ]);
  });
});
