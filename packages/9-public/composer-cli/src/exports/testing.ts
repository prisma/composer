/**
 * Public surface (the `./testing` subpath): `createOperationsDouble`, the
 * fixture-backed double of the operations the command family calls, for hosts that test how they
 * mount the command family without running real deploys; and
 * `renderDevStackFile`, the dev stack file `dev` writes, with the configuration-file
 * writers `dev` uses, for tests that drive Alchemy directly.
 */
export * from '@internal/cli/testing';
