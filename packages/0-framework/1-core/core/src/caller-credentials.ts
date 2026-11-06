/**
 * What the caller has already authenticated: a workspace and a platform API
 * client. The framework hands it, unchanged, to every extension hook that
 * talks to the platform: the container lifecycle, `preflight`, reporters,
 * `providers` and the state descriptor's `create`. A caller that holds neither
 * omits it, and the extension falls back to whatever credential protocol it
 * defines for itself (for Prisma Cloud, its environment variables).
 *
 * `C` is the extension's own platform-client type, left as a type parameter
 * because this shared-plane module must not import a platform SDK; the
 * framework only carries the value, never calls it. The framework stores the
 * erased `C = unknown` form and the extension recovers its concrete client
 * through method bivariance on the hooks that receive it.
 */
export interface CallerCredentials<C = unknown> {
  /** The workspace the caller acts in. `undefined` when the caller has no workspace to name — the extension decides whether it can proceed. */
  readonly workspaceId: string | undefined;
  /** An already-authenticated platform API client. Present means the extension must not build its own from the environment. */
  readonly client?: C | undefined;
}
