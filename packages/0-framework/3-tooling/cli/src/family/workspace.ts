import type { CommandContext } from '@prisma/cli-engine';

/**
 * The workspace the in-process leg acts in, from the engine's credential
 * read. Handlers never decode a token and never read PRISMA_WORKSPACE_ID:
 * whether the credential came from a stored session or the environment, the
 * engine has already resolved it, and branching on where it came from is a
 * defect by the credential-manager design.
 *
 * Undefined when the active credential names no workspace — an environment
 * token whose claims carry none. The container descriptors raise their own
 * "workspace required" error in that case, which is the error the user needs.
 */
export async function workspaceIdOf(
  ctx: Pick<CommandContext<never>, 'activeCredential'>,
): Promise<string | undefined> {
  const credential = await ctx.activeCredential();
  return credential?.workspaceId;
}
