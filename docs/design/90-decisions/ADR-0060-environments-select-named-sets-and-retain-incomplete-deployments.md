# ADR-0060: Environments select named sets; missing values leave a recoverable deployment

## Decision

Prisma Cloud configuration lives in **named environment sets**: project-owned
collections of user-provided environment variables. An environment selects one set.
A new project starts with one set, `default`, shared by all its branches.
Authors can create more sets and select them through the Prisma Cloud target's
deploy configuration, without changing the application graph.

```text
Project: shop
  Environment sets                  Branches selected by Composer environments
  default  { STRIPE_KEY: unset } <── main, pr-42, pr-43

  Optional separation:
  production { … }              <── main
  staging    { … }              <── staging
  previews   { … }              <── pr-42, pr-43

Deploy ──> create project, branch, set and missing variable names
       ──> retain the uploaded bundle and deployment attempt
       ──> deploy if configuration is complete
           otherwise show missing names and a Console link
Console ──> enter values ──> Redeploy ──> same bundle, fresh configuration
```

Set names have no built-in meaning. Selecting `production` does not change a
branch's role, and selecting `previews` does not make a branch a preview.
Branches still own their compute, databases, generated credentials, and deploy
state. Only the user-provided values in the selected set are shared.

If a set or a declared variable is absent, Composer creates it. Missing values
appear as empty fields in Console, with an explicit **unset** state in storage;
an intentionally saved empty string is a value, not a placeholder. Ensuring a
set or declaring its keys never overwrites values already saved there.

A missing runtime value does not undo project creation or discard an uploaded
bundle. The attempt remains visible in Console as needing configuration.
Composer output and Console identify the set, branch, affected services, and
missing names. Composer provides a direct link to the relevant Console editor
and returns a structured failure, so CI cannot report an undeployed app as a
successful deployment. Values never appear in these diagnostics.

After entering values, the user clicks **Redeploy**. The platform creates a new
deployment from that attempt's exact retained bundle and runtime settings,
with a fresh configuration snapshot. This works before the app has ever had a
successful deployment. It requires neither a new push nor the deploy machine.

## Reasoning

A per-branch configuration map makes every new preview repeat setup that is
usually identical. A shared default lets a user deploy without designing an
environment strategy first. Named sets let that same user separate production,
staging, and previews when their needs grow. Selecting a set is a deployment
choice; reusable services still declare inputs without knowing a set's name.

Configuration often becomes known only after the first deploy. Creating the
project, declaring the missing keys, and retaining the bundle gives the user a
place to finish setup and one clear next action. Requiring a second build or a
first successful promotion would break that recovery path.

A deployment's environment remains a snapshot. Saving a set does not change
running instances or restart every branch that uses it. Redeploy deliberately
combines the retained code with current values. Console shows which branches
use a shared set so the effect of an edit is clear.

This amends ADR-0023 and ADR-0024's branch/class-based configuration model,
ADR-0029 and ADR-0032's early refusal of missing platform values, and ADR-0042's
refusal to proceed when runtime input values are missing. It also narrows
ADR-0048's failed-deployment cleanup: an attempt awaiting configuration must
retain its artifact for recovery. The schema remains the authority on valid
input; missing values do not permit schema introspection or invented defaults.

## Consequences

- The Prisma Cloud target owns set creation, selection, and variable sources.
  Core stays target-agnostic. Project-owned shared sets live outside any one
  branch's Alchemy state; destroying an environment must not delete a shared set.
- User values stay encrypted on the platform and out of Alchemy state. Composer
  carries names, bindings, and change metadata. Generated `COMPOSER_*` wiring
  and resource credentials stay branch-scoped and cannot enter a shared set.
- A retained attempt includes the input bindings needed to resolve values on
  retry. Unresolved runtime sources remain references; they must not be frozen
  into the bundle as omitted fields or empty literals. Validation still runs
  before application code receives input. An optional absent value remains
  optional according to the service's schema.
- Recovery applies to missing runtime configuration. Invalid graphs, invalid
  schemas, build failures, denied access, failed uploads, and platform errors
  keep their own errors. A value consumed by the application's build requires
  rebuilding; Console must not promise the same-bundle path for it.
- Redeploy names the source attempt and checks that it belongs to the same app
  and branch. It must not silently use the last promoted deployment, switch to
  a different bundle, or retry an unavailable artifact. Retention and expiry
  must be visible to the user.
- Editing a shared set requires permission for every branch whose next deploy
  can consume it, including production. Attaching a set cannot bypass that
  rule. Saving values and redeploying remain separate actions.
- Existing production and preview values remain separate until explicitly
  mapped to sets. Upgrading never copies production values into a default
  shared with previews. Legacy storage remains available during migration;
  removing its UI does not authorize deleting its values.
- Composer continues to compose upstream Alchemy providers. Supporting retained
  attempts must extend that lifecycle rather than introduce a second provider
  for an already supported resource.

## Alternatives considered

- **Remove Preview and require values on every branch.** Simplifies the editor
  but repeats setup for each preview and leaves first-deploy recovery unsolved.
- **Keep exactly Production and Preview sets.** Covers one layout but forces
  staging and other persistent environments into categories they do not fit.
- **Stop before provisioning whenever a value is missing.** Leaves the user
  without an app to inspect or a bundle that Console can redeploy.
- **Copy a set onto each branch.** Values drift after copying, and a rotation
  requires finding and updating every copy.
- **Mutate the existing deployment's environment or restart all consumers on
  save.** Makes a configuration edit change running applications implicitly
  and loses the deployment's configuration snapshot.

## Related

- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) and
  [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
  — a deployed environment maps to a branch; user configuration can be shared
  through a set.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) and
  [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  — environment sources carry names, never user values in deploy state.
- [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md) — the target
  owns container resolution before the deploy engine runs.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — bindings carry
  sources; the application's schema judges their resolved values.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md)
  — the structured failure returned when configuration is incomplete.
- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md)
  — Composer composes upstream providers and preserves environment-write ordering.
- [ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md) — an
  environment is the place the app runs; its selected set holds user values.
