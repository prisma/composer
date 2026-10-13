/**
 * Test fixture: the compute daemon with a 1-second readiness timeout, so a
 * test can reach the timeout without waiting for the production default.
 */
process.argv.push('--ready-timeout-ms', '1000');

export {};

await import('@internal/dev-emulators/compute-main');
