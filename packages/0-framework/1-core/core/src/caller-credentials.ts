/**
 * What the caller has already authenticated, handed unchanged to every
 * extension hook that talks to the platform. `C` is the extension's own client
 * type: this module cannot import a platform SDK.
 */
export interface CallerCredentials<C = unknown> {
  /** The workspace the caller acts in. `undefined` when the caller has no workspace to name — the extension decides whether it can proceed. */
  readonly workspaceId: string | undefined;
  /** An already-authenticated platform API client. Present means the extension must not build its own from the environment. */
  readonly client?: C | undefined;
}
