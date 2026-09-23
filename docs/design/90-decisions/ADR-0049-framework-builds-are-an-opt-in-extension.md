# ADR-0049: Framework builds are an opt-in Composer extension

## Decision

An app may choose `@prisma/composer-frameworks` to build a service with
Alchemy's published `@alchemy.run/frontend-frameworks` Node target during
Composer assembly. Existing `node()` and `nextjs()` descriptors still consume
outputs built by the user.

```ts
compute({
  name: 'web',
  build: frameworkBuild({ module: import.meta.url, framework: 'vite', root: '..' }),
});
```

This is an explicit exception to ADR-0005's user-build boundary and to
ADR-0027's two-public-package inventory. It does not change the core's build
contract or the Prisma Cloud deployment topology.

## Reasoning

Alchemy maintains framework build targets separately from its cloud resources.
The extension calls their public `build()` operation directly, then
hands the resulting dedicated Node output to Composer's existing safe
assembler. Next.js is the exception: its upstream target reports the project
root as its output, so Composer uses its existing standalone assembler after
the upstream build. The project root is never copied as a deploy artifact.

Composer still adds its boot wrapper and controls the App, environment rows,
Deployment, state, and local emulators. Using Alchemy's higher-level Website
resource instead would create a second resource lifecycle and bypass the
typed configuration and self-origin wiring in ADR-0048.

Local `composer dev` runs the same framework build and assembly on a source
change. It does not start Alchemy's separate `dev()` server: that server does
not receive Composer's local service bindings and Postgres emulator. Generated
outputs and deploy state are excluded from the source watcher.

## Consequences

- The extension and the framework package are opt-in dependencies. Apps using
  existing descriptors do not change their build workflow.
- An opted-in service builds on each deploy and on source changes in local
  dev. It trades native framework hot-module replacement for the same
  Composer runtime and bindings locally and in production.
- Vite's Node target serves static output through a Compute service. A
  separate static-only resource lifecycle is not introduced here.
- The framework output must have a dedicated Node entry inside the project;
  an upstream target that does not produce one is rejected rather than
  staging the whole project.
- Compatibility is pinned to an Alchemy, Effect, and frontend-frameworks
  release set and must be verified with the actual framework versions before
  a template changes its descriptor.

## Alternatives considered

- **Replace Composer deployment with Alchemy Website resources.** Rejected:
  they own another App and Deployment and cannot express Composer's current
  typed input, secret, and self-origin sequence.
- **Copy the project root returned by a framework target.** Rejected: it
  could include source, credentials, build caches, and unbounded dependencies.
- **Use each framework's native dev server.** Deferred until it can receive
  Composer's local bindings without a second lifecycle.

## Related

- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md)
- [ADR-0027](ADR-0027-two-packages-compose-and-compose-prisma-cloud.md)
- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)
- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md)
