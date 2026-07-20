/**
 * Destroy teardown (ADR-0034): after `alchemy destroy` has removed the stage's
 * resources, remove the stage's deploy-state database — the store the destroy
 * was reading until a moment ago, and the last thing Composer owns on the
 * stage's Branch.
 *
 * Control-plane only (imported by control.ts → prisma-composer.config.ts); runs
 * in the CLI parent, so it builds its own Management API client from env — the
 * same credential path preflight uses.
 */
import type { TeardownInput } from '@internal/core/config';
import {
  fromEnv,
  type ManagementApiClient,
  ManagementClient,
  managementClientLayer,
} from '@internal/lowering';
import {
  deleteStateDatabaseWith,
  type OwnershipVerifier,
  verifyOwnership,
} from '@internal/lowering/state';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { prismaCloudContainerOf } from './container.ts';

const tokenRequiredError = (): Error =>
  new Error('environment variable PRISMA_SERVICE_TOKEN is required for destroy teardown.');

async function managementClient(): Promise<ManagementApiClient> {
  if ((process.env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) throw tokenRequiredError();
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ManagementClient;
    }).pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv())))),
  );
}

/**
 * The Prisma Cloud extension's `teardown`. Removes the stage's state database,
 * with failure handling that differs by stage because the consequences do:
 *
 * - **Named stage: throw.** The Branch delete that follows would fail anyway —
 *   the platform refuses a Branch that still has a database attached — so
 *   failing here names the actual cause instead of a confusing symptom.
 * - **Production: warn and continue.** Nothing blocks the Project delete on
 *   this; removing the database only stops production's state outliving
 *   production and holding a quota slot. That is a cleanup step, and a cleanup
 *   step must not fail the command.
 *
 * Accepts an injected client and ownership verifier for tests; otherwise
 * builds a client from env and verifies against the real database.
 */
export async function runTeardown(
  input: TeardownInput,
  deps?: { readonly client?: ManagementApiClient; readonly verify?: OwnershipVerifier },
): Promise<void> {
  const { projectId, branchId } = prismaCloudContainerOf(input.container);
  const isNamedStage = branchId !== undefined;
  try {
    const client = deps?.client ?? (await managementClient());
    await Effect.runPromise(
      deleteStateDatabaseWith(
        {
          projectId,
          ...(branchId !== undefined ? { branchId } : {}),
        },
        deps?.verify ?? verifyOwnership,
      ).pipe(Effect.provideService(ManagementClient, client)),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isNamedStage) {
      throw new Error(`Failed to delete the deploy-state database: ${reason}`);
    }
    console.warn(`Could not remove production's deploy-state database: ${reason}`);
  }
}
