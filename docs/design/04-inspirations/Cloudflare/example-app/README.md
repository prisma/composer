# Cloudflare Workers: Runtime Env Bindings Example

This scaffold illustrates how **control-plane configuration** (wrangler.toml) maps to **runtime env** bindings in a Cloudflare Worker.

## Control-Plane vs Runtime Env

| Layer | Where | Purpose |
|-------|-------|---------|
| **Control-plane** | `wrangler.toml` | Declares bindings (KV, R2, D1, vars, secrets). IDs and names must exist in your Cloudflare account. |
| **Runtime env** | `fetch(request, env)` | Receives those bindings as typed properties on `env`. No direct access to secrets or account IDs; only the bound interfaces. |

The Worker receives only what is bound in wrangler.toml. Bindings are injected at deploy time; there is no separate "env file" at runtime.

## Bindings in This Example

- **KV** (`EXAMPLE_KV`): Key-value namespace for fast reads/writes
- **R2** (`EXAMPLE_R2`): Object storage bucket
- **D1** (`DB`): SQLite database

Placeholder IDs in wrangler.toml must be replaced with real IDs from your account (see below).

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm install -g wrangler` (or use `npx wrangler`)

## Setup

1. **Login**: `npx wrangler login`

2. **Create resources** (run from project root):

```bash
# KV namespace
npx wrangler kv namespace create EXAMPLE_KV
# Copy the returned id into wrangler.toml under [[kv_namespaces]]

# R2 bucket
npx wrangler r2 bucket create example-bucket

# D1 database
npx wrangler d1 create example-db
# Copy database_id into wrangler.toml under [[d1_databases]]
```

3. **Apply migrations** (optional, for D1):

```bash
npx wrangler d1 execute example-db --local --file=./schema.sql
```

## Running

```bash
# Install deps
npm install

# Local dev (uses .dev.vars for secrets if needed)
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## Endpoints

| Path | Binding | Description |
|------|---------|-------------|
| `/` | - | Index with endpoint list |
| `/kv` | EXAMPLE_KV | Write/read a demo KV key |
| `/r2` | EXAMPLE_R2 | Put/get a demo R2 object |
| `/d1` | DB | Run a simple D1 query |

# Cloudflare Workers: Runtime Env Bindings Example

This scaffold illustrates how **control-plane configuration** (wrangler.toml) maps to **runtime env** bindings in a Cloudflare Worker.

## Control-Plane vs Runtime Env

| Layer | Where | Purpose |
|-------|-------|---------|
| **Control-plane** | `wrangler.toml` | Declares bindings (KV, R2, D1, vars, secrets). IDs and names must exist in your Cloudflare account. |
| **Runtime env** | `fetch(request, env)` | Receives those bindings as typed properties on `env`. No direct access to secrets or account IDs; only the bound interfaces. |

The Worker receives only what is bound in wrangler.toml. Bindings are injected at deploy time; there is no separate “env file” at runtime.

## Bindings in This Example

- **KV** (`EXAMPLE_KV`): Key-value namespace for fast reads/writes
- **R2** (`EXAMPLE_R2`): Object storage bucket
- **D1** (`DB`): SQLite database

Placeholder IDs in wrangler.toml must be replaced with real IDs from your account (see below).

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm install -g wrangler` (or use `npx wrangler`)

## Setup

1. **Login**: `npx wrangler login`

2. **Create resources** (run from project root):

   ```bash
   # KV namespace
   npx wrangler kv namespace create EXAMPLE_KV
   # Copy the returned id into wrangler.toml under [[kv_namespaces]]

   # R2 bucket
   npx wrangler r2 bucket create example-bucket

   # D1 database
   npx wrangler d1 create example-db
   # Copy database_id into wrangler.toml under [[d1_databases]]
   ```

3. **Apply migrations** (optional, for D1):

   ```bash
   npx wrangler d1 execute example-db --local --file=./schema.sql
   ```

## Running

```bash
# Install deps
npm install

# Local dev (uses .dev.vars for secrets if needed)
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## Endpoints

| Path | Binding | Description |
|------|---------|-------------|
| `/` | - | Index with endpoint list |
| `/kv` | EXAMPLE_KV | Write/read a demo KV key |
| `/r2` | EXAMPLE_R2 | Put/get a demo R2 object |
| `/d1` | DB | Run a simple D1 query |
