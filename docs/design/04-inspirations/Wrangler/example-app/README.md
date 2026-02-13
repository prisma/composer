# Wrangler Example App

Scaffold demonstrating **Wrangler workflows** and **artifact boundary** concepts. Use this to understand how config, code, and environments produce a deployable artifact.

## Artifact Boundary

The **artifact boundary** is the line between authoring (config + code) and deployment:

```
Config (wrangler.toml) + Code (src/index.ts) → Bundle → Artifact → Deploy
```

- The **artifact** is what runs: the bundled Worker plus resolved config (routes, bindings, vars).
- You typically don't touch the bundle directly, but you *can* inspect it with `wrangler deploy --dry-run --outdir dist`.

## Prerequisites

- Node.js 18+
- Cloudflare account (`wrangler login`)

```bash
npm install
```

## Workflows

### 1. Dev (local)

Run the Worker locally with hot-reload. Uses same config + code path as deploy.

```bash
npm run dev
# Or with env:
npm run dev:staging
npm run dev:production
```

- Loads `wrangler.toml`, merges `--env` section
- Bundles entrypoint, starts Miniflare
- Hit `http://localhost:8787` (or port shown)

### 2. Deploy

Build and upload artifact to Cloudflare.

```bash
npm run deploy           # default env
npm run deploy:staging   # env.staging → Worker name: example-worker-staging
npm run deploy:production
```

- Config + code → bundle → upload → apply routes and bindings

### 3. Preview (versioned URL, no promote)

Upload a version without making it the active deployment. Get a versioned preview URL.

```bash
npm run preview
npm run preview:staging
```

- Use `--preview-alias` for a stable staging alias: `wrangler versions upload --preview-alias staging`

### 4. Dry-run + outdir inspection

Emit the artifact to disk **without deploying**. Inspect what gets uploaded.

```bash
npm run dry-run
# Or:
npm run dry-run:staging
npm run dry-run:production
```

Then:

```bash
ls -la dist/
```

You'll see the bundle and metadata Wrangler would upload. This is the **artifact boundary** made visible.

### 5. Tail (remote logs)

Stream live logs from a deployed Worker.

```bash
npm run tail
npm run tail:staging
npm run tail:production
```

Make requests to the deployed Worker and watch logs in real time.

## Config: Inheritable vs Non-Inheritable

See `wrangler.toml` comments. Summary:

| Type | Examples | Behavior |
|------|----------|----------|
| **Inheritable** | `main`, `compatibility_date`, `route` | Top-level values cascade to envs; envs can override |
| **Non-inheritable** | `vars`, `kv_namespaces`, `r2_buckets`, etc. | Must be specified per `[env.<name>]`; top-level applies only to default env |

Worker name per env: `<<name>>-<<env>>` (e.g. `example-worker-staging`).

## package.json Scripts

| Script | Wrangler command |
|--------|------------------|
| `dev` | `wrangler dev` |
| `dev:staging` | `wrangler dev --env staging` |
| `deploy` | `wrangler deploy` |
| `deploy:staging` | `wrangler deploy --env staging` |
| `preview` | `wrangler versions upload` |
| `dry-run` | `wrangler deploy --dry-run --outdir dist` |
| `tail` | `wrangler tail` |
| `check` | `wrangler check` |

# Wrangler Example App

Scaffold demonstrating **Wrangler workflows** and **artifact boundary** concepts. Use this to understand how config, code, and environments produce a deployable artifact.

## Artifact Boundary

The **artifact boundary** is the line between authoring (config + code) and deployment:

```
Config (wrangler.toml) + Code (src/index.ts) → Bundle → Artifact → Deploy
```

- The **artifact** is what runs: the bundled Worker plus resolved config (routes, bindings, vars).
- You typically don't touch the bundle directly, but you *can* inspect it with `wrangler deploy --dry-run --outdir dist`.

## Prerequisites

- Node.js 18+
- Cloudflare account (`wrangler login`)

```bash
npm install
```

## Workflows

### 1. Dev (local)

Run the Worker locally with hot-reload. Uses same config + code path as deploy.

```bash
npm run dev
# Or with env:
npm run dev:staging
npm run dev:production
```

- Loads `wrangler.toml`, merges `--env` section
- Bundles entrypoint, starts Miniflare
- Hit `http://localhost:8787` (or port shown)

### 2. Deploy

Build and upload artifact to Cloudflare.

```bash
npm run deploy           # default env
npm run deploy:staging   # env.staging → Worker name: example-worker-staging
npm run deploy:production
```

- Config + code → bundle → upload → apply routes and bindings

### 3. Preview (versioned URL, no promote)

Upload a version without making it the active deployment. Get a versioned preview URL.

```bash
npm run preview
npm run preview:staging
```

- Use `--preview-alias` for a stable staging alias: `wrangler versions upload --preview-alias staging`

### 4. Dry-run + outdir inspection

Emit the artifact to disk **without deploying**. Inspect what gets uploaded.

```bash
npm run dry-run
# Or:
npm run dry-run:staging
npm run dry-run:production
```

Then:

```bash
ls -la dist/
```

You’ll see the bundle and metadata Wrangler would upload. This is the **artifact boundary** made visible.

### 5. Tail (remote logs)

Stream live logs from a deployed Worker.

```bash
npm run tail
npm run tail:staging
npm run tail:production
```

Make requests to the deployed Worker and watch logs in real time.

## Config: Inheritable vs Non-Inheritable

See `wrangler.toml` comments. Summary:

| Type | Examples | Behavior |
|------|----------|----------|
| **Inheritable** | `main`, `compatibility_date`, `route` | Top-level values cascade to envs; envs can override |
| **Non-inheritable** | `vars`, `kv_namespaces`, `r2_buckets`, etc. | Must be specified per `[env.<name>]`; top-level applies only to default env |

Worker name per env: `<<name>>-<<env>>` (e.g. `example-worker-staging`).

## package.json Scripts

| Script | Wrangler command |
|--------|------------------|
| `dev` | `wrangler dev` |
| `dev:staging` | `wrangler dev --env staging` |
| `deploy` | `wrangler deploy` |
| `deploy:staging` | `wrangler deploy --env staging` |
| `preview` | `wrangler versions upload` |
| `dry-run` | `wrangler deploy --dry-run --outdir dist` |
| `tail` | `wrangler tail` |
| `check` | `wrangler check` |
