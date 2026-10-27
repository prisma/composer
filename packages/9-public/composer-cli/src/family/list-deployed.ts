import { resolveAppIdentity, validateStageName } from '@internal/cli/app-identity';
import type { ComposerConfigSource } from '@internal/cli/control';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import { readDeployedStage } from '@internal/lowering/deployed';
import type { ManagementApiClient } from '@prisma/cli-engine';
import { type DeployedNode, deployedNodes } from './deployed-nodes.ts';

export interface ListDeployedInput {
  readonly config: ComposerConfigSource;
  readonly entry: string | undefined;
  readonly name: string | undefined;
  readonly stage: string | undefined;
  readonly cwd: string;
  readonly workspaceId: string | undefined;
  readonly client: ManagementApiClient;
}

function notFound(app: string, stage: string | undefined): CliStructuredError {
  return new CliStructuredError(
    'DEPLOY.TARGET_NOT_FOUND',
    `Nothing deployed for ${app}${stage === undefined ? '' : `/${stage}`}.`,
    { fix: 'Deploy it first.' },
  );
}

function lookupFailed(error: unknown): CliStructuredError {
  return new CliStructuredError(
    'DEPLOY.CONTAINER_FAILED',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

/** Every node the app has deployed on the stage, or `DEPLOY.TARGET_NOT_FOUND` when the stage has no Project, Branch or topology. */
export async function listDeployed(
  input: ListDeployedInput,
): Promise<Result<readonly DeployedNode[], CliStructuredError>> {
  let app: string;
  try {
    if (input.stage !== undefined) validateStageName(input.stage);
    app = (await resolveAppIdentity(input.entry, input.name, input.cwd, input.config)).name;
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
  if (input.workspaceId === undefined) {
    return notOk(lookupFailed(new Error('environment variable PRISMA_WORKSPACE_ID is required.')));
  }

  let stage: Awaited<ReturnType<typeof readDeployedStage>>;
  try {
    stage = await readDeployedStage(input.client, {
      workspaceId: input.workspaceId,
      appName: app,
      stage: input.stage,
    });
  } catch (error) {
    return notOk(lookupFailed(error));
  }
  const nodes = stage === undefined ? [] : deployedNodes(stage);
  if (nodes.length === 0) return notOk(notFound(app, input.stage));
  return ok(nodes);
}
