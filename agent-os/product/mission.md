# Product Mission

## Pitch
Prisma Compose is a TypeScript application framework that helps application developers (and the AI agents they work with) define
multi-service applications for the Prisma Platform by authoring code that can be statically analyzed into
infrastructure-as-code requirements and wired at runtime via dependency injection.

## Users

### Primary Customers
- Application developers: Build apps in TypeScript and want the platform to infer and provision the required services.
- Agent builders / power users: Use AI agents to scaffold, extend, and maintain applications with predictable structure.
- Prisma Platform team (internal): Needs a clear artifact + metadata contract to provision and run user apps safely.

### User Personas
**Application Developer** (22–45)
- **Role:** Full-stack developer
- **Context:** Shipping an app that needs an API, background work, storage, streaming, and scheduled tasks
- **Pain Points:** Manually wiring infrastructure, unclear service boundaries, brittle config drift across environments
- **Goals:** Define the app in code once; get the right services provisioned; predictable local dev and testing

**Agent-Assisted Builder** (22–45)
- **Role:** Developer using AI agents as a primary workflow
- **Context:** Wants agents to generate scaffolded services and iterate without “breaking the shape” of the app
- **Pain Points:** Unstructured codebases are hard for agents to modify safely; inconsistent patterns and hidden coupling
- **Goals:** Framework conventions that make apps easy for agents to scaffold, refactor, and verify over time

## The Problem

### Multi-service apps are hard to define, provision, and evolve
Modern apps are composed of services (HTTP APIs, workers, event subscribers, cron jobs, streaming, storage) but developers
must manually specify and maintain infrastructure configuration and runtime wiring. This leads to config drift, slower
iteration, and fragile environment parity (local/test/prod).

**Our Solution:** Provide a TypeScript framework for defining executable units and their dependencies in a way that can be
statically analyzed into a service topology (IaC requirements), then executed with dependency-injected implementations
appropriate to the environment (Prisma Platform, local emulation, isolated tests).

## Differentiators

### Static topology inference from code structure
Unlike traditional “config-first” IaC, Prisma Compose infers the service map directly from TypeScript definitions.
This results in fewer sources of truth and less drift between code and infrastructure.

### Environment-swappable implementations via DI
Unlike frameworks that tightly couple runtime services, Prisma Compose is designed to swap implementations for local dev and tests
without changing app code, enabling fast iteration and easy isolation.

## Key Features

### Core Features
- **Service definition DSL:** Define units (HTTP APIs, workers, subscribers, cron) and their dependencies in TypeScript.
- **Static graph builder:** Build a service dependency graph/topology from code for provisioning and deployment planning.
- **Execution entrypoints:** Run the app’s entrypoints (server, worker, subscriber, etc.) in a consistent way.

### Collaboration Features
- **Composable Components:** Compose pre-packaged units with explicit “ports” (dependencies) and link them together safely.
- **Prisma Next integration:** Seamless integration with Prisma Next so common workflows work out of the box.

### Advanced Features
- **Platform interface contract:** Artifact structure + metadata map (JSON) for Prisma Compute/Foundry to provision and run
  services and enforce dependency/data contracts.
