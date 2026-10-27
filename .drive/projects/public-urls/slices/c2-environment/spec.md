# C2 — The term is environment

Parent: [public-urls spec](../../spec.md) (the project folder lives on the `docs/adr-ingress-and-stage-config` branch until prisma/composer#386 merges). Decision: ADR-0059 on main.

## At a glance

```sh
# before
prisma deploy --stage staging
prisma deploy                         # production, no name
# after
prisma deploy --environment staging
prisma deploy                         # the environment production
prisma deploy --stage staging         # CLI.COMMAND_MOVED: use --environment <name>
```

```ts
// before
await destroy({ target: { kind: 'stage', stage: 'staging' }, config });
await destroy({ target: { kind: 'production' }, config });
// after
await destroy({ environment: 'staging', config });
await destroy({ environment: 'production', config });
await destroy({ config }); // type error; at runtime DEPLOY.ENVIRONMENT_REQUIRED
```

## Chosen design

- **Core knows only environment names.** Every place that carried `stage: string | undefined` (undefined meaning production) carries `environment: string`. The container key is `{ appName, environment }`; the extension preflight and teardown inputs carry `environment`. Nothing in core compares the name with `production` or `dev`.
- **Defaults are command parameters.** `prisma deploy` and `prisma deploy list` default `--environment` to `production`, and the `deploy` operation's `environment` input does too. `prisma dev` gains no flag in this slice; the `dev` operation runs as the environment `dev`. `destroy` has no default: `environment` is a required field, and a call without a non-empty name fails with `DEPLOY.ENVIRONMENT_REQUIRED`.
- **Name validation applies to every environment**, including the defaults: it must pass `git check-ref-format`. A name made only of letters, digits, `-` and `_`, starting with a letter or digit, is a valid ref by construction and is accepted without running `git`, so a deploy still needs no `git` on PATH. Codes become `DEPLOY.ENVIRONMENT_INVALID` and `DEPLOY.ENVIRONMENT_UNVALIDATABLE`.
- **`--stage` is retired through the CLI engine's redirect table** on `deploy`, so typing it fails with `CLI.COMMAND_MOVED` naming `--environment <name>`. No alias. `deploy list` gets no redirect: the engine refuses to start when a redirect names a command the host has not mounted, released hosts do not mount `deploy list` yet, and no released host ever offered `deploy list --stage`. There it is an unknown flag.
- **Prisma Cloud maps the name.** `production` resolves exactly as a deploy without `--stage` did: the Project's default Branch found by `isDefault` (never `role`), resources without a `branchId`, the Build without a branch reference, the default Branch's id as the Alchemy stage, and destroy never deletes that Branch. Any other name resolves to the Branch with that `gitName`, created on deploy if absent. A name other than `production` whose `gitName` lookup returns the default Branch (for example `main`) is refused: it would be production under a second name, and destroying it would tear production down.
- **Mismatched versions are refused, not misread.** The `prisma` host pins its Composer version and the app installs its own extension, so the two can differ. After an extension resolves a container, core checks that the container's `input.environment` is the name it asked for, before anything is deployed or destroyed; a container resolved without it (an extension older than the CLI) fails with `DEPLOY.CONTAINER_MISMATCH`, naming the upgrade. The Prisma Cloud extension refuses a call without an environment name (a CLI older than the extension). Without these, an older extension would read every name as production.
- **The default-Branch refusal arrives as `DEPLOY.CONTAINER_FAILED`**, with a message that names the cause. No dedicated code: the refusal is the Prisma Cloud mapping's, and core's codes stay target-neutral.
- **The Alchemy stage** is the state-owning container's `alchemyStage`, else the environment name. `DEPLOY.SCOPE_MISSING` goes, since a name always exists. Alchemy's own `--stage` flag and its state API path segments keep their word: that is engine vocabulary.
- **Local dev is out of this slice.** `prisma dev` takes no `--environment` yet; it hands the local target's container and hooks the name `dev`, and everything about local instances stays as it is. Giving each environment its own local copy is slice [C3](../c3-local-environments/spec.md), split out on 2026-10-27 because it is new behaviour, not a rename. The local-dev doc drops "Stages do not apply" and says local dev runs as `dev`, with per-environment local copies to follow.
- **Public output.** The `--report` JSON's `stage: string | null` becomes `environment: string`. The deploy summary line names the environment. Errors that named a stage name the environment; errors that can only know the Alchemy stage (lease, state) name the Branch id as a Branch.
- **This repository's tooling.** `scripts/composer-destroy.ts` takes `--environment <name>`, required; `--production` and `--stage` go. The examples' `destroy` scripts pass `--environment production`; `env-param` uses `ENV_PARAM_ENVIRONMENT` and `destroy:environment`. The CI action `deploy-verify-destroy` takes an `environment` input (default `production`) and passes `--environment` to deploy, `deploy list` verification and destroy.

## Coherence rationale

One breaking rename with one release note: every author changes `--stage` to `--environment` and every `destroy` caller changes `target` to `environment` once. Splitting code from docs would ship a release whose guides describe the old flag.

## Scope

In: `packages/` (core, CLI, Prisma Cloud lowering and extension, composer-cli's `deploy list`), `examples/`, `scripts/`, `.github/`, `docs/guides/`, `skills/`, `website/` copy if any, `docs/design/10-domains/deploy-cli.md`, `local-dev.md`, `docs/design/05-prisma-cloud/alchemy-lowering.md`, and other non-ADR design docs that describe the flag. Also the error-code registry in ADR-0044, which that record says is edited when codes change, and one-line amendment notes pointing to ADR-0059 on the records whose examples show the old interface and that prisma/composer#386 does not already amend (ADR-0038, ADR-0043, ADR-0053).

Deliberately out: rewriting older decision records under `docs/design/90-decisions/` (ADR-0059 carries the decision); Alchemy's own `stage` vocabulary (its CLI flag, `LowerOptions.stage`, state API paths, `ALCHEMY_STAGE_PATTERN`); internal identifiers that name Alchemy stages; `resolve()` and `environment.name` in module bodies (slice C1).

## Pre-investigated edge cases

| Case | Handling |
| --- | --- |
| `--environment main` names the default Branch's `gitName` | Refused with an error saying production is `--environment production` (or no flag). |
| `--environment production` explicitly | Identical to no flag. |
| Container payload serialized to the Alchemy child | Payload carries `environment`; parent and child are always the same version. |
| Help examples and `--help` text | Must say `--environment`. |

## Slice-specific done conditions

`prisma deploy --environment staging` works end to end; `prisma deploy` deploys `production` to the same Branch as before; `--stage` fails naming `--environment`; `destroy` takes a name and refuses without one; a boundary search for `stage` over user-facing text finds only Alchemy's own API; the examples' CI deploys with `--environment`.

## Open questions

None.

## References

ADR-0059; ADR-0024 and ADR-0050 (destroy is explicit); ADR-0052 (local instances per directory); `docs/design/10-domains/deploy-cli.md`, `local-dev.md`; `.agents/rules/full-surface-rename.mdc`, `user-facing-surface-changes.mdc`.
