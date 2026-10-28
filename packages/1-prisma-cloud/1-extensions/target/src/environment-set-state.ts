export interface RuntimeEnvironmentSet {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly keys: readonly string[];
  readonly missing: readonly string[];
  readonly consoleUrl: string;
}

/** Reads target-owned metadata only; platform values never cross the preflight transport. */
export function readEnvironmentSetState(
  payload: string | undefined,
): RuntimeEnvironmentSet | undefined {
  if (payload === undefined) return undefined;
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null || !('environmentSet' in parsed))
    return undefined;
  const set = parsed.environmentSet;
  if (
    typeof set !== 'object' ||
    set === null ||
    !('id' in set) ||
    typeof set.id !== 'string' ||
    !('name' in set) ||
    typeof set.name !== 'string' ||
    !('projectId' in set) ||
    typeof set.projectId !== 'string' ||
    !('branchId' in set) ||
    typeof set.branchId !== 'string' ||
    !('consoleUrl' in set) ||
    typeof set.consoleUrl !== 'string' ||
    !('keys' in set) ||
    !stringArray(set.keys) ||
    !('missing' in set) ||
    !stringArray(set.missing)
  ) {
    throw new Error(
      'prisma-cloud: named environment set metadata did not survive preflight transport.',
    );
  }
  return {
    id: set.id,
    name: set.name,
    projectId: set.projectId,
    branchId: set.branchId,
    keys: set.keys,
    missing: set.missing,
    consoleUrl: set.consoleUrl,
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
