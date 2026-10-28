# C3 — dispatch plan

Spec: [spec.md](spec.md). Two dispatches run in parallel: they touch disjoint files, and the spec pins what the docs must say.

## D1. Local dev keys everything by environment

- **Outcome:** the code under `packages/` follows the spec.
  - `.prisma-composer/dev/<encoded environment>/` holds the record, `env.json`, `secrets.json`, the stack file, `artifacts/` and `buckets/<app>/<bucket>`.
  - The record has no `current` app; running an app or environment stops nothing else.
  - Alchemy runs with `--stage <environment>`; `--fresh` and teardown remove only `.alchemy/state/<app>/<environment>` and that environment's instances and files.
  - `dev url <address> --environment` reads the app from the address with no module import; `dev stop --environment --name` reads the app as `prisma dev` does.
  - The local-target seam's `current` takes app and environment instead of returning what ran last.
  - Instances get an environment label; `emulator list` prints it at the end of each line.
  - A pre-C3 folder is moved into `dev` on first run.
  - `prisma dev` runs the extension version check and refuses with `DEPS.EXTENSION_INCOMPATIBLE`.
- **Tests:** one per acceptance criterion 1–8, at the narrowest layer that proves it, plus the migration of a pre-C3 folder from a fixture.
- **Builds on:** main at 3708c638.
- **Hands to:** `pnpm build`, `pnpm typecheck`, `pnpm lint` and the affected package tests pass.

## D2. The design docs describe it

- **Outcome:** amendment notes on the per-folder record decision and the `dev url` / `dev stop` decision; `docs/design/10-domains/local-dev.md` and any guide or skill that describes `dev url`, `dev stop`, `--fresh` or "the app last run" updated.
- **Builds on:** the spec.
- **Hands to:** a grep for "last run", "current app" and "stops the previous" over `docs/`, `skills/` and `website/` finds nothing stale.

## D3. Verify (orchestrator)

Full test suite; real `prisma dev` of an example in `dev` and `test` at once, `dev url` for each, `dev stop --environment test`, `--fresh` on `test` with `dev`'s data intact, and an upgrade from a folder made by the released CLI; `/drive-code-review` without the walkthrough; fixes.
