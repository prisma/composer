import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lower } from "@makerkit/core/lower";
import { prismaCloud } from "@makerkit/prisma-cloud/target";
import service from "./src/service.ts";

/**
 * Deploy script (heavy imports — never bundled): lowers the authored service
 * onto Prisma Cloud. One project (its default Postgres, auto-injected as
 * DATABASE_URL) + one Compute service + one Deployment.
 *
 *   pnpm build     # bundles src/main.ts + manifest → dist/hello.tar.gz
 *   pnpm deploy    # builds, sources ../../.env, runs `alchemy deploy`
 *
 * Requires env (repo-root .env, see `pnpm setup:env`):
 * PRISMA_SERVICE_TOKEN, PRISMA_WORKSPACE_ID, ALCHEMY_PASSWORD.
 */
const artifact = fileURLToPath(new URL("./dist/hello.tar.gz", import.meta.url));

const workspaceId = process.env.PRISMA_WORKSPACE_ID;
if (!workspaceId) throw new Error("PRISMA_WORKSPACE_ID is required");

export default lower(service, prismaCloud({ workspaceId }), {
  name: "makerkit-hello",
  artifact: {
    path: artifact,
    sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
  },
});
