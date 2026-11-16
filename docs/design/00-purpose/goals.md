# Goals

The concrete aims that deliver Prisma Composer's [purpose](README.md). Each is derived
from the purpose, not the other way around.

## Goals

- **Derive your application's provisioning configuration from its TypeScript
  source.** The infrastructure your app needs — its services, resources, and the
  connections between them — is generated from your code, not hand-authored in a
  separate config or IaC file.
- **Provision and deploy via Alchemy — no manual wiring.** One command, or your CD
  pipeline, provisions the infrastructure and deploys the module to a target.
- **Pluggable deployment targets.** Targets are extension packs; the framework
  ships the Prisma Cloud pack, and the core stays target-agnostic.
- **A queryable topology.** The inferred topology is a first-class artifact you and
  your agents can interrogate from the CLI.
- **Recreate the whole topology in a fresh environment.** Every element has a managed lifecycle, so standing up a new environment provisions the entire module from nothing, with no click-ops. The one prerequisite is the platform variables the app reads, such as API keys: for now the operator sets them on the platform first, because the deploy does not copy local values to the platform. Before any service or database is created, the deploy names every platform variable a service needs that has no value, with the command that sets it.
- **Reproduce every element in the local dev emulator.** The same topology runs
  locally: each Resource ships a local stand-in beside its real provider, so
  `prisma dev` emulates the deployed module without touching the cloud.

## Non-goals

- **A bespoke provisioning orchestrator.** Provisioning runs through Alchemy's
  engine (client- or CD-driven); a future server-side orchestrator can evolve
  independently.
- **Bundling or compiling your code.** Bundlers (tsdown, Bun.build, Alchemy) do
  that; the framework references the bundles.
- **Generating data contracts.** Prisma ORM produces those; the framework
  references them.
- **UI / client-framework bindings.** React hooks and Convex-style embedding are a
  deployment-target pack concern, not the core.
