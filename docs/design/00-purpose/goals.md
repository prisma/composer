# Goals

The concrete aims that deliver MakerKit's [purpose](README.md). Each is derived
from the purpose, not the other way around.

## Goals

- **Derive your application's provisioning configuration from its TypeScript
  source.** The infrastructure your app needs — its services, resources, and the
  connections between them — is generated from your code, not hand-authored in a
  separate config or IaC file.
- **Provision and deploy via Alchemy — no manual wiring.** One command, or your CD
  pipeline, provisions the infrastructure and deploys the system to a target.
- **Pluggable deployment targets.** Targets are extension packs; MakerKit ships the
  Prisma Cloud pack, and the core stays target-agnostic.
- **A queryable topology.** The inferred topology is a first-class artifact you and
  your agents can interrogate from the CLI.
- **Recreate the whole topology in a fresh environment.** Every element has a
  managed lifecycle, so standing up a new environment provisions the entire system
  from nothing — no click-ops, no manually-created prerequisites.
- **Reproduce every element in the local dev emulator.** The same topology runs
  locally: each Resource ships a local stand-in beside its real provider, so
  `prisma dev` emulates the deployed system without touching the cloud.

## Non-goals

- **A bespoke provisioning orchestrator.** Provisioning runs through Alchemy's
  engine (client- or CD-driven); a future server-side orchestrator can evolve
  independently.
- **Bundling or compiling your code.** Bundlers (tsdown, Bun.build, Alchemy) do
  that; MakerKit references the bundles.
- **Generating data contracts.** Prisma Next produces those; MakerKit references
  them.
- **UI / client-framework bindings.** React hooks and Convex-style embedding are a
  deployment-target pack concern, not the core.
