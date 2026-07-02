/**
 * The lowering table — the only place @makerkit/prisma-alchemy is imported.
 * Deploy-time only; never lands in a runtime bundle.
 */
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Prisma from "@makerkit/prisma-alchemy";
import type { Target } from "@makerkit/core/lower";

export interface PrismaCloudOptions {
  workspaceId: string;
  region?: Prisma.ComputeRegion;
}

export const prismaCloud = (o: PrismaCloudOptions): Target => ({
  name: "prisma-cloud",

  // Alchemy's Stack types its providers Layer against the per-resource
  // requirements inferred from the stack effect, which the ProviderCollection
  // returned by Prisma.providers() does not structurally unify with — a
  // pre-existing typings gap in prisma-alchemy. It satisfies them at runtime;
  // this is the one commented cast, and it lives in the pack, not core.
  providers: () => Prisma.providers() as unknown as Layer.Layer<never>,

  lower: {
    // For now the postgres input is served by the project's default database
    // (Compute auto-injects DATABASE_URL), so it provisions nothing itself.
    // It becomes a real Database resource when contracts/multiple DBs arrive.
    "prisma-cloud/postgres": () => Effect.succeed({ outputs: {} }),

    // The service is the deployment unit: Project + ComputeService + Deployment.
    "prisma-cloud/compute": ({ id, opts }) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project(`${id}-project`, {
          workspaceId: o.workspaceId,
          name: id,
        });
        const svc = yield* Prisma.ComputeService(`${id}-svc`, {
          projectId: project.id,
          name: id,
          region: o.region ?? "us-east-1",
        });
        const deploy = yield* Prisma.Deployment(`${id}-deploy`, {
          computeServiceId: svc.id,
          artifactPath: opts.artifact.path,
          artifactHash: opts.artifact.sha256,
          port: 3000,
        });
        // outputs are the inter-node config-wiring hook: expose what hand-wired
        // neighbors in a mixed stack need (the URL for consumers; the project id
        // for e.g. an EnvironmentVariable scoped to this service's project).
        return { outputs: { url: deploy.deployedUrl, projectId: project.id } };
      }),
  },
});
