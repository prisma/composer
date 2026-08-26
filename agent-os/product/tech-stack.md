# Product Tech Stack

This is the tech stack for building the **Prisma Composer** (the TypeScript framework) and its supporting toolchain, plus the
platform primitives it targets on the Prisma Platform.

## Framework & Runtime
- **Language:** TypeScript
- **Runtime (target):** Bun (Prisma Compute runs JS on Bun instances)
- **Runtime (dev/tooling):** Node.js `>=22.18` (the version that turns TypeScript type stripping on by default, which is how the CLI imports the user's `.ts` entry) + Bun where useful
- **Distribution:** npm packages (Prisma Composer as a library + companion packages)
- **Package Manager:** pnpm (match Prisma ORM; pnpm workspaces)
- **Monorepo tooling:** Turborepo (task runner + caching)
- **Module system:** ESM (`"type": "module"`)

## Platform Primitives (Target Environment)
- **Database:** Prisma Postgres
- **Compute:** Prisma Compute (VM-based, Bun runtime)
- **File Storage:** Prisma File Storage (working title; not yet created)
- **Streaming:** Durable Streams (working title; not yet created)

## Build & Tooling (match Prisma ORM)
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
- **Framework integration:** Prisma ORM (must integrate seamlessly)

## Local Dev & Testing
- **Local runtime:** Local implementations/emulators of platform services (storage/streams/compute) swapped via DI
- **Test isolation:** Easy per-test/per-suite environment isolation by swapping implementations and/or provisioning isolated resources
- **Test Framework:** Vitest (match Prisma ORM)
- **Frontend/tooling (if needed):** Vite (match Prisma ORM toolchain usage)

## Quality
- **Linting/Formatting:** Biome (match Prisma ORM)
- **ESLint:** Used selectively (e.g., custom lint rules packaged as an ESLint plugin), otherwise prefer Biome
- **Type Safety:** TypeScript strict mode (recommended; align with shared tsconfig)

## CI/CD
- **CI:** GitHub Actions (recommended; TBD)
