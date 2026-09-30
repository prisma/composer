/**
 * Public surface (the `./testing` subpath): `createControlDouble`, the
 * fixture-backed double of the control API, for hosts that test how they
 * mount the command family without running real deploys; and
 * `renderDevStackFile`, the dev stack file `dev` writes, for tests that drive
 * Alchemy directly.
 */
export * from '@internal/cli/testing';
