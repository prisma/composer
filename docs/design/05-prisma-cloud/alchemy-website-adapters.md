# Alchemy website adapters in Composer (draft)

## Goal

Use Alchemy's maintained Node framework targets for Next.js, Astro, Nuxt,
SvelteKit, TanStack Start, and Vite, and its static-site path for prerendered
apps. Composer should stop maintaining framework-specific artifact layouts once
the corresponding upstream target passes our build, local-dev, deployment, and
runtime checks.

This is an implementation plan, not a declaration that the current Composer
service path has already moved to `Prisma.Website.*`.

## Source checked

Alchemy `v2.0.0-beta.79` adds `Prisma.Website.{Nextjs,Astro,Nuxt,SvelteKit,
TanStackStart,Vite,StaticSite}`. A framework composite calls `Website.Server`
to build with `@alchemy.run/frontend-frameworks`, packages its output through
`Prisma.WebsiteArtifact`, then calls `Prisma.Compute`. `StaticSite` uses
`Command.Build` and the same artifact/deployment path. The frontend-frameworks
package and `@vercel/nft` are optional Alchemy peers, not automatically supplied
by an application that installs Composer.

Composer currently assembles every service *before* Alchemy runs. Its
`BuildAdapter` identifies already-built output, while the Prisma Cloud target
creates `Prisma.App`, writes typed configuration as
`Prisma.EnvironmentVariable` resources, and only then creates
`Prisma.Deployment`. The generated boot wrapper must run before the app entry
to make `service.input()` and `load()` work.

## Integration boundary

Do not replace the current `compute` lowering with a `Prisma.Website.*` call.
That composite creates and owns a different App, environment map, and
Deployment. In particular, `COMPOSER_<ADDRESS>_ORIGIN` depends on the App's
assigned domain; placing that value inside a composite that also creates the
App forms an Alchemy dependency cycle. It would also bypass Composer's typed
input document, secret pointers, environment-change triggers, and boot wrapper.
The reasons for the low-level resource sequence in ADR-0048 still apply.

Instead, split the framework adapter's **build/artifact** work from the
Composer service's **runtime/deployment** work:

1. Add an opt-in framework build descriptor. It selects one upstream
   `@alchemy.run/frontend-frameworks/<framework>/node` target and a project
   root. The target builds the user's framework and yields its authoritative
   output directory and server entry. The build runs once, not once in a
   template script and again inside Composer.
2. Package that output using Alchemy's website artifact implementation, with
   Composer's boot wrapper as the actual deployment entry. Preserve the
   upstream target's runtime files, static assets, and safe symlink behavior.
   The artifact producer must expose a supported reusable API; importing an
   internal Alchemy source file or copying its tracing code is not acceptable.
3. Keep Composer's existing App → environment rows → Deployment sequence,
   including environment triggers and the self-origin row. Only the artifact
   input changes. Existing `node()` and `nextjs()` applications retain their
   current behavior until an explicit adapter migration is verified.
4. Give the new build descriptor a local-dev counterpart. It should invoke the
   upstream framework's native dev server while Composer supplies the same
   typed bindings and Postgres emulator. A production-only adapter would
   regress `prisma composer dev`.
5. Add a static-site descriptor using the upstream static server/artifact path.
   Static sites need no Composer boot wrapper, but must still share the same
   project, branch, deploy report, and destroy lifecycle. Allow an application
   containing only a static site; `assembleServices` currently rejects graphs
   with zero services.

## Upstream seam needed

`Prisma.WebsiteArtifact` and its staging function are currently internal to
Alchemy, and `Website.Server` is driven by the full website composite. We need
a supported way to call the framework build and artifact stages separately,
then hand their artifact to Composer's low-level `Prisma.Deployment`. This can
be an exported builder/artifact API or a composite accepting an existing App,
environment resources, and a deployment entry wrapper. Choose the smallest
surface with Alchemy maintainers before replacing a Composer adapter.

## Validation before switching a template

For each framework: scaffold with its normal package manager, build, run
`composer dev`, deploy to a fresh project, request a dynamic route and a static
asset, change a typed input or secret and verify replacement, then destroy.
For Astro and Vite also verify prerendered/static output and SPA/404 routing.
Run the same checks on macOS, Linux, and Windows where the framework supports
them. A typecheck or successful upload alone does not prove the site boots.

## Migration order

1. Agree the upstream reusable build/artifact API and pin a compatible
   Alchemy + Effect pair. An exploratory bump from Composer's current
   `alchemy@2.0.0-beta.74` to `beta.79` compiles but fails 13 existing
   lowering tests; those provider and Effect changes must be resolved before
   the bump is mergeable.
2. Land one framework end to end behind an explicit descriptor, including
   local dev and a deployed runtime check.
3. Add the remaining framework targets and static sites using the same seam.
4. Migrate create-prisma templates only after their exact scaffold/deploy
   paths pass against the released Composer package.

No template migration or release should be inferred from this draft alone.
