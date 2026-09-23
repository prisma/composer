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

Alchemy main (`b261867f`, 2026-09-23) and the published
`@alchemy.run/frontend-frameworks@2.0.0-beta.79` already separate framework
building from deployment. The package exports Node targets for Next.js, Astro,
Nuxt, SvelteKit, TanStack Start, and Vite. Its public framework contract has
independent `build()` and `dev()` operations. `build()` returns a `BuildOutput`
with `distDirectory`, `clientDirectory`, and entry-first `serverModules` (or an
assets-only output). No Alchemy provider or Compute service is needed to call
that build operation.

Alchemy's higher-level `Prisma.Website.*` resources use this separate package
through `Website.Server`, then package its output through
`Prisma.WebsiteArtifact` and deploy with `Prisma.Compute`. `StaticSite` uses
`Command.Build` and the same artifact/deployment path. These composites are
convenient for standalone sites, but are not the only way to use the framework
adapters. The frontend-frameworks package and `@vercel/nft` are optional
Alchemy peers, not automatically supplied by an application that installs
Composer.

Source: [package exports](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/frontend-frameworks/package.json),
[framework contract](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/frontend-frameworks/src/core/Framework.ts),
[build output](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/frontend-frameworks/src/core/BuildOutput.ts),
and [Prisma website composite](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/alchemy/src/Prisma/Website/FrameworkSite.ts).

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

Use the already separate framework package for **build/dev**, and keep
Composer's **runtime/deployment** work:

1. Add an opt-in Composer build descriptor. During Composer's existing
   assembly phase, it calls the public `make(...).build()` operation with the
   upstream Node target and project root. This deliberately changes ADR-0005's
   build boundary for this descriptor only; current descriptors remain
   build-output consumers. Do not also run the user's build from a template
   script.
2. Convert the returned `BuildOutput` into a Composer bundle. Its
   `serverModules[0]` is the server entry; `clientDirectory` includes static
   and prerendered output. Preserve the target's runtime files and Composer's
   boot wrapper without blindly copying the project root (the Next.js Node
   target reports the project root as its distribution directory). Start with
   Composer's existing safe assembly/packaging primitives and prove the
   resulting artifact boots. If they cannot safely stage a target, address
   that packaging gap explicitly rather than making a build API a prerequisite.
3. Keep Composer's existing App → environment rows → Deployment sequence,
   including environment triggers and the self-origin row. Only the artifact
   input changes. Existing `node()` and `nextjs()` applications retain their
   current behavior until an explicit adapter migration is verified.
4. Give the new build descriptor a local-dev counterpart using the package's
   independent `dev()` operation while Composer supplies the same typed
   bindings and Postgres emulator. A production-only adapter would regress
   `prisma composer dev`.
5. Add a static-site descriptor using the package's exported Node static-server
   helper and Composer's artifact path.
   Static sites need no Composer boot wrapper, but must still share the same
   project, branch, deploy report, and destroy lifecycle. Allow an application
   containing only a static site; `assembleServices` currently rejects graphs
   with zero services.

## API boundary

No Alchemy PR is required to expose framework `build()` or `dev()`; those are
already published by `@alchemy.run/frontend-frameworks`. The remaining
integration is Composer-owned: map `BuildOutput` to a safe Composer artifact,
then keep its low-level deployment topology. Alchemy's website artifact
staging is internal today, so using that specific staging implementation would
need a separate supported API, but it is not a prerequisite for trying the
public framework adapters with Composer's existing packager.

## Validation before switching a template

For each framework: scaffold with its normal package manager, build, run
`composer dev`, deploy to a fresh project, request a dynamic route and a static
asset, change a typed input or secret and verify replacement, then destroy.
For Astro and Vite also verify prerendered/static output and SPA/404 routing.
Run the same checks on macOS, Linux, and Windows where the framework supports
them. A typecheck or successful upload alone does not prove the site boots.

## Migration order

1. Pin a compatible frontend-frameworks, Alchemy, and Effect set. The
   frontend-frameworks `beta.79` package requires Effect `rc.115` or newer;
   Composer currently uses `rc.112`. An exploratory combined bump to Alchemy
   `beta.79` and Effect `rc.117` compiles but fails 13 lowering tests; those
   changes must be resolved before that combined bump is mergeable. Keeping
   Alchemy `beta.74` while raising Effect to `rc.117` is not a shortcut either:
   its profile module still calls the removed `Config.string()` API. The
   framework build API exists independently, but the compatible dependency
   set still needs an upgrade and verification.
2. Land one framework end to end behind an explicit descriptor, including
   local dev and a deployed runtime check.
3. Add the remaining framework targets and static sites using the same seam.
4. Migrate create-prisma templates only after their exact scaffold/deploy
   paths pass against the released Composer package.

No template migration or release should be inferred from this draft alone.
