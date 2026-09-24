# ADR-0049: Framework builds are an opt-in Composer extension

## Decision

An app may choose `@prisma/composer/frameworks` to build a service with
Alchemy's published `@alchemy.run/frontend-frameworks` Node target during
Composer assembly. The low-level `node()` descriptor still consumes output
built by the user. The public `nextjs()` subpath is replaced by the framework
adapter; Composer no longer maintains a Next.js standalone assembler.

The available framework names are derived from the installed Alchemy package's
Node-target exports rather than maintained as a second Composer list.

```ts
compute({
  name: 'web',
  build: framework({ module: import.meta.url, framework: 'vite', root: '..' }),
});
```

This is an explicit exception to ADR-0005's user-build boundary and to
ADR-0027's original core authoring surface. It does not change the core's build
contract or the Prisma Cloud deployment topology.

## Reasoning

Alchemy maintains framework build targets separately from its cloud resources.
The extension calls their public `build()` operation directly, then uses
Alchemy's Prisma website artifact staging to select the build, assets, and
traced runtime dependencies. Next.js reports the project root as its output;
Alchemy's staging selects only its deployable files. Composer adds its boot
wrapper and packages the staged output for its own lifecycle.

Composer still adds its boot wrapper and controls the App, environment rows,
Deployment, state, and local emulators. Using Alchemy's higher-level Website
resource instead would create a second resource lifecycle and bypass the
typed configuration and self-origin wiring in ADR-0048.

Local `prisma-composer dev` runs the same framework build and assembly on a source
change. It does not start Alchemy's separate `dev()` server: that server does
not receive Composer's local service bindings and Postgres emulator. Generated
outputs and deploy state are excluded from the source watcher.

## Consequences

- The framework subpath and its optional peers are opt-in. Apps using
  existing descriptors do not change their build workflow.
- An opted-in service builds on each deploy and on source changes in local
  dev. It trades native framework hot-module replacement for the same
  Composer runtime and bindings locally and in production.
- Vite's Node target serves static output through a Compute service. A
  separate static-only resource lifecycle is not introduced here.
- Framework builds use Alchemy's Prisma website staging, not a second Composer
  framework packager. Next.js does not require `output: 'standalone'`. The old
  internal standalone assembler and its testing helper are removed.
- The framework output must have a Node entry inside the project. Except for
  Next.js, its reported output must be a dedicated directory inside the project.
- Compatibility is pinned to an Alchemy, Effect, and frontend-frameworks
  release set and must be verified with the actual framework versions before
  a template changes its descriptor.

## Alternatives considered

- **Replace Composer deployment with Alchemy Website resources.** Rejected:
  they own another App and Deployment and cannot express Composer's current
  typed input, secret, and self-origin sequence.
- **Copy the project root returned by a framework target.** Rejected: it
  could include source, credentials, build caches, and unbounded dependencies.
- **Keep Composer's Next.js standalone assembler.** Rejected: Alchemy already
  packages Next.js for Prisma Compute, so maintaining another framework-specific
  packager duplicates its work.
- **Use each framework's native dev server.** Deferred until it can receive
  Composer's local bindings without a second lifecycle.

## Related

- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md)
- [ADR-0027](ADR-0027-two-packages-compose-and-compose-prisma-cloud.md)
- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)
- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md)
