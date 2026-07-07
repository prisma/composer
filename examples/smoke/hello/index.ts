// Trivial Bun HTTP service, deployed to Prisma Compute by the smoke stack to
// prove the Compute provider end to end. Uses an explicit Bun.serve (matching
// ignite-bot) rather than a default-export server, which does not reliably
// auto-start from a bundled entrypoint run as `bun index.js`.
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch(): Response {
    return new Response('hello from prisma compute\n');
  },
});

console.log(`hello listening on 0.0.0.0:${port}`);
