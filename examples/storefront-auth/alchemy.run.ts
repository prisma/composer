import * as Alchemy from "alchemy";
import { localState } from "alchemy/State/LocalState";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Prisma from "@makerkit/prisma-alchemy";

const artifact = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The storefront-auth MVP: two hexes, each its own Prisma project (a Service
 * plus its own default Postgres), wired so the Storefront calls Auth while
 * serving a request. Provisioned through our v2 Alchemy providers against real
 * Prisma Cloud.
 *
 *   pnpm build     # builds both hex artifacts → dist/*.tar.gz
 *   pnpm deploy    # builds, sources ../../.env, runs `alchemy deploy`
 *
 * Requires env (in the repo-root .env, see `pnpm setup:env`):
 * PRISMA_SERVICE_TOKEN, PRISMA_WORKSPACE_ID, ALCHEMY_PASSWORD.
 */
export default Alchemy.Stack(
  "StorefrontAuth",
  { providers: Prisma.providers(), state: localState() },
  Effect.gen(function* () {
    const workspaceId = process.env.PRISMA_WORKSPACE_ID;
    if (!workspaceId) {
      return yield* Effect.die(new Error("PRISMA_WORKSPACE_ID is required"));
    }

    // Auth hex — Bun/Hono service + its own Postgres (the project's default
    // database, auto-injected as DATABASE_URL).
    const authArtifact = artifact("./hexes/auth/dist/auth.tar.gz");
    const authProject = yield* Prisma.Project("auth-project", {
      workspaceId,
      name: "makerkit-auth",
    });
    const authSvc = yield* Prisma.ComputeService("auth-svc", {
      projectId: authProject.id,
      name: "auth",
      region: "us-east-1",
    });
    const authDeploy = yield* Prisma.Deployment("auth-deploy", {
      computeServiceId: authSvc.id,
      artifactPath: authArtifact,
      artifactHash: sha256(authArtifact),
      port: 3000,
    });

    // Storefront hex — Next.js service + its own Postgres. AUTH_URL wires it to
    // the Auth hex and is set before the Storefront version deploys, so the
    // version resolves it from the project's production environment.
    const storefrontArtifact = artifact("./hexes/storefront/dist/storefront.tar.gz");
    const storefrontProject = yield* Prisma.Project("storefront-project", {
      workspaceId,
      name: "makerkit-storefront",
    });
    yield* Prisma.EnvironmentVariable("storefront-auth-url", {
      projectId: storefrontProject.id,
      key: "AUTH_URL",
      value: authDeploy.deployedUrl ?? "",
      class: "production",
    });
    const storefrontSvc = yield* Prisma.ComputeService("storefront-svc", {
      projectId: storefrontProject.id,
      name: "storefront",
      region: "us-east-1",
    });
    const storefrontDeploy = yield* Prisma.Deployment("storefront-deploy", {
      computeServiceId: storefrontSvc.id,
      artifactPath: storefrontArtifact,
      artifactHash: sha256(storefrontArtifact),
      port: 3000,
    });

    return {
      authUrl: authDeploy.deployedUrl,
      storefrontUrl: storefrontDeploy.deployedUrl,
    };
  }),
);
