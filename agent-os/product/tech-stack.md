# Product Tech Stack

This is the tech stack for building the **Prisma Compose** (the TypeScript framework) and its supporting toolchain, plus the
platform primitives it targets on the Prisma Platform.

## Framework & Runtime
- **Language:** TypeScript
- **Runtime (target):** Bun (Prisma Compute runs JS on Bun instances)
- **Runtime (dev/tooling):** Node.js (Prisma Next stack uses Node `>=24`) + Bun where useful
- **Distribution:** npm packages (Prisma Compose as a library + companion packages)
- **Package Manager:** pnpm (match Prisma Next; pnpm workspaces)
- **Monorepo tooling:** Turborepo (task runner + caching)
- **Module system:** ESM (`"type": "module"`)

## Platform Primitives (Target Environment)
- **Database:** Prisma Postgres
- **Compute:** Prisma Compute (VM-based, Bun runtime)
- **File Storage:** Prisma File Storage (working title; not yet created)
- **Streaming:** Durable Streams (working title; not yet created)

## Build & Tooling (match Prisma Next)
- **Build system:** Turbo pipelines (`turbo run build`, `turbo watch build`)
- **Package builds:** tsdown (base config) and tsup (where needed)
- **Typechecking:** `tsc --noEmit` with TS project references
- **Versioning/Release:** Changesets
- **Git hooks:** Husky + lint-staged
- **Dependency rules:** dependency-cruiser (enforce package boundaries/architecture)

## API / Architecture
- **App definition model:** TypeScript DSL to define executable units + dependencies (static analyzable)
- **Topology output:** Build a static service graph for provisioning (IaC inference)
- **Runtime wiring:** Dependency injection of service implementations (platform vs local vs test)
- **Artifacts + metadata:** Standard artifact structure plus a dependency/contract map JSON for upload to Foundry (working title)
- **Composition:** “Component” abstraction for bundling units with explicit ports and linkable dependencies

## Integrations
- **ORM / Data Access:** Prisma ORM
- **Framework integration:** Prisma Next (must integrate seamlessly)

## Local Dev & Testing
- **Local runtime:** Local implementations/emulators of platform services (storage/streams/compute) swapped via DI
- **Test isolation:** Easy per-test/per-suite environment isolation by swapping implementations and/or provisioning isolated resources
- **Test Framework:** Vitest (match Prisma Next)
- **Frontend/tooling (if needed):** Vite (match Prisma Next toolchain usage)

## Quality
- **Linting/Formatting:** Biome (match Prisma Next)
- **ESLint:** Used selectively (e.g., custom lint rules packaged as an ESLint plugin), otherwise prefer Biome
- **Type Safety:** TypeScript strict mode (recommended; align with shared tsconfig)

## CI/CD
- **CI:** GitHub Actions (recommended; TBD)
