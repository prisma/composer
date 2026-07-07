import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Prisma from '@makerkit/prisma-alchemy';
import * as Alchemy from 'alchemy';
import { localState } from 'alchemy/State/LocalState';
import * as Effect from 'effect/Effect';

/**
 * Smoke test: provision a single Prisma Postgres database through our v2
 * Alchemy provider — proving the provider + Alchemy's engine + the Management
 * API auth work end to end against real Prisma Cloud.
 *
 *   alchemy deploy   # create project -> database -> connection
 *   alchemy destroy  # tear it all down
 *
 * Requires env: PRISMA_SERVICE_TOKEN, PRISMA_WORKSPACE_ID, ALCHEMY_PASSWORD.
 */
export default Alchemy.Stack(
  'PrismaSmoke',
  { providers: Prisma.providers(), state: localState() },
  Effect.gen(function* () {
    const workspaceId = process.env.PRISMA_WORKSPACE_ID;
    if (!workspaceId) {
      return yield* Effect.die(new Error('PRISMA_WORKSPACE_ID is required'));
    }

    const project = yield* Prisma.Project('smoke-project', {
      workspaceId,
      name: 'makerkit-smoke',
    });

    // A project auto-provisions its default database, so create a non-default one.
    const database = yield* Prisma.Database('smoke-db', {
      projectId: project.id,
      name: 'smoke',
      region: 'us-east-1',
      isDefault: false,
    });

    const connection = yield* Prisma.Connection('smoke-conn', {
      databaseId: database.id,
      name: 'app',
    });

    // Compute: deploy a trivial hello service (pre-built into ./dist/hello.tar.gz).
    const artifactPath = fileURLToPath(new URL('./dist/hello.tar.gz', import.meta.url));
    const artifactHash = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');

    const service = yield* Prisma.ComputeService('smoke-svc', {
      projectId: project.id,
      name: 'smoke-svc',
      region: 'us-east-1',
    });

    const deployment = yield* Prisma.Deployment('smoke-deploy', {
      computeServiceId: service.id,
      artifactPath,
      artifactHash,
      port: 3000,
    });

    return {
      projectId: project.id,
      databaseId: database.id,
      connectionId: connection.id,
      computeServiceId: service.id,
      endpointDomain: deployment.deployedUrl,
      versionId: deployment.versionId,
    };
  }),
);
