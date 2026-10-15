/**
 * Test fixture: the compute daemon probing a starting service's port only
 * every 3 seconds, so a test can act between a child's exit and the moment
 * its start notices.
 */
process.argv.push('--ready-poll-ms', '3000');

export {};

await import('@internal/dev-emulators/compute-main');
