/**
 * The version of the shapes the `prisma` host and the app's
 * `@prisma/composer` pass each other through `internal/converge`:
 * `LowerOptions`, `ConvergeRequest`, `ConvergeOutcome`, `ConvergeEvent` and
 * `DeploymentResult`. Bump it only when one of them changes in a way the
 * other side cannot read. Imports nothing, so a host can read it before
 * loading the converge.
 */
export const CONVERGE_CONTRACT = 1;
