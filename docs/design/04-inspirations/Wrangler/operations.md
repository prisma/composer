# Wrangler operations (research)

This document enumerates the "verbs" (operations) on the core domain concepts, as implied by the Wrangler CLI and configuration model.

Source context: [Wrangler documentation](https://developers.cloudflare.com/workers/wrangler/)

## Operations on configuration

- **Create / init**
  - Scaffold a new Worker project via `wrangler init` (or C3 tool). Generates config, entrypoint, and optionally deploys.
- **Validate**
  - `wrangler check` validates the Worker. Schema validation for config is supported via `$schema` in `wrangler.jsonc`.
- **Resolve**
  - Merge top-level and environment-specific config; apply `--env` selection.
- **Source of truth**
  - Config file overrides dashboard values on deploy (unless `keep_vars`). Best practice: treat config as authoritative.

## Operations on Worker lifecycle

- **Develop locally**
  - `wrangler dev`: start local server; bundle on change; bindings default to local simulations.
- **Deploy**
  - `wrangler deploy`: bundle, upload artifact, apply routes/bindings to Cloudflare.
- **Delete**
  - `wrangler delete`: remove Worker from Cloudflare.
- **Preview**
  - `wrangler versions upload`: upload version without promoting; returns versioned preview URL. `--preview-alias` assigns human-readable alias.
- **Rollback**
  - `wrangler rollback`: revert to a prior deployment.
- **Inspect**
  - `wrangler versions`, `wrangler deployments`: list recent versions/deployments.

## Operations on bindings / resources

- **Declare**
  - Add bindings in config (KV, R2, D1, Durable Objects, Queues, AI, Vectorize, services, etc.).
- **Auto-provision (beta)**
  - Omit resource IDs in config; Wrangler creates resources on deploy and writes IDs back to config.
- **Remote in dev**
  - Set `remote: true` per binding to use live Cloudflare resources during `wrangler dev`.
- **Resource management**
  - `wrangler d1 create|list|execute|migrations ...`, `wrangler kv namespace|key|bulk ...`, `wrangler r2 bucket|object ...`, etc.

## Operations on build / bundle

- **Bundle**
  - Default: esbuild bundles entrypoint and npm deps. Output inspectable via `wrangler deploy --dry-run --outdir dist`.
- **Custom build**
  - `build.command`, `build.cwd`, `build.watch_dir` in config run a pre-step before Wrangler bundling.
- **Disable bundle**
  - `wrangler deploy --no-bundle`: use pre-built output directly (plain JS, no deps).
- **Include additional modules**
  - `find_additional_modules` + `rules`: include unbundled modules (e.g. Wasm, dynamic imports) in the deployment.
- **Minify**
  - `minify` in config (or Vite's `build.minify` when using Vite plugin).

## Operations on observability / troubleshooting

- **Tail logs**
  - `wrangler tail`: livestream logs from a deployed Worker.
- **Types generation**
  - `wrangler types`: generate types from bindings and module rules.
- **Docs**
  - `wrangler docs [SEARCH]`: open Cloudflare docs in browser.

## Operations on auth / project context

- **Login**
  - `wrangler login`: OAuth flow to authorize with Cloudflare account.
- **Context**
  - `--config`, `--cwd`, `--env`, `--env-file`: control which config and env are used.

## Open questions / assumptions

- Assumption: `wrangler check` covers both config and code validation; exact scope may vary by Wrangler version.
- Open: Does auto-provision write back to TOML as well as JSON config, or only JSON?
- Open: What is the full taxonomy of resource-management subcommands (containers, d1, kv, r2, queues, workflows, etc.) for Prisma Compose mapping?

# Wrangler operations (research)

This document enumerates the “verbs” (operations) on the core domain concepts, as implied by the Wrangler CLI and configuration model.

Source context: [Wrangler documentation](https://developers.cloudflare.com/workers/wrangler/)

## Operations on configuration

- **Create / init**
  - Scaffold a new Worker project via `wrangler init` (or C3 tool). Generates config, entrypoint, and optionally deploys.
- **Validate**
  - `wrangler check` validates the Worker. Schema validation for config is supported via `$schema` in `wrangler.jsonc`.
- **Resolve**
  - Merge top-level and environment-specific config; apply `--env` selection.
- **Source of truth**
  - Config file overrides dashboard values on deploy (unless `keep_vars`). Best practice: treat config as authoritative.

## Operations on Worker lifecycle

- **Develop locally**
  - `wrangler dev`: start local server; bundle on change; bindings default to local simulations.
- **Deploy**
  - `wrangler deploy`: bundle, upload artifact, apply routes/bindings to Cloudflare.
- **Delete**
  - `wrangler delete`: remove Worker from Cloudflare.
- **Preview**
  - `wrangler versions upload`: upload version without promoting; returns versioned preview URL. `--preview-alias` assigns human-readable alias.
- **Rollback**
  - `wrangler rollback`: revert to a prior deployment.
- **Inspect**
  - `wrangler versions`, `wrangler deployments`: list recent versions/deployments.

## Operations on bindings / resources

- **Declare**
  - Add bindings in config (KV, R2, D1, Durable Objects, Queues, AI, Vectorize, services, etc.).
- **Auto-provision (beta)**
  - Omit resource IDs in config; Wrangler creates resources on deploy and writes IDs back to config.
- **Remote in dev**
  - Set `remote: true` per binding to use live Cloudflare resources during `wrangler dev`.
- **Resource management**
  - `wrangler d1 create|list|execute|migrations ...`, `wrangler kv namespace|key|bulk ...`, `wrangler r2 bucket|object ...`, etc.

## Operations on build / bundle

- **Bundle**
  - Default: esbuild bundles entrypoint and npm deps. Output inspectable via `wrangler deploy --dry-run --outdir dist`.
- **Custom build**
  - `build.command`, `build.cwd`, `build.watch_dir` in config run a pre-step before Wrangler bundling.
- **Disable bundle**
  - `wrangler deploy --no-bundle`: use pre-built output directly (plain JS, no deps).
- **Include additional modules**
  - `find_additional_modules` + `rules`: include unbundled modules (e.g. Wasm, dynamic imports) in the deployment.
- **Minify**
  - `minify` in config (or Vite’s `build.minify` when using Vite plugin).

## Operations on observability / troubleshooting

- **Tail logs**
  - `wrangler tail`: livestream logs from a deployed Worker.
- **Types generation**
  - `wrangler types`: generate types from bindings and module rules.
- **Docs**
  - `wrangler docs [SEARCH]`: open Cloudflare docs in browser.

## Operations on auth / project context

- **Login**
  - `wrangler login`: OAuth flow to authorize with Cloudflare account.
- **Context**
  - `--config`, `--cwd`, `--env`, `--env-file`: control which config and env are used.

## Open questions / assumptions

- Assumption: `wrangler check` covers both config and code validation; exact scope may vary by Wrangler version.
- Open: Does auto-provision write back to TOML as well as JSON config, or only JSON?
- Open: What is the full taxonomy of resource-management subcommands (containers, d1, kv, r2, queues, workflows, etc.) for Prisma Compose mapping?
