# Platform variables: project spec

Design: [design.md](design.md), which is authoritative. Plan: [plan.md](plan.md).

## Purpose

A service should be able to read values that live on the platform, without Composer carrying, storing or seeding them, and without the deploy needing them. The app's graph should still say which services read which values, and what type each expects.

## At a glance

```ts
export default appRoot('shop', {}, ({ provision }) => {
  const from = provision(variable({ name: 'EMAIL_FROM' }));
  const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
  const smtpPort = provision(variable({ name: 'SMTP_PORT', schema: type('number') }));

  provision(email(), { input: { from, deliveryCredential, smtpPort } });
});
```

The root, written with `appRoot()`, provisions the three nodes; a nested `module()` cannot, by type. Each node is a named request for a value the operator supplies, under that name, at whichever platform scope the operator chooses. The deploy writes a marker naming each variable into the email service's input document, and creates no value. At boot the service reads each variable, decodes `SMTP_PORT`'s text as a number, checks it, and boxes the credential. `prisma dev` fills the same variables from `.env` files and the shell.

## Non-goals

- **Platform changes.** The project ships against the Management API as it is (design section 3). It does not add a record of which service reads which variable, a void value or workspace variables to the platform.
- **Isolating a service's environment on Prisma Cloud.** Every deployment receives every project variable of its class, as today.
- **Seeding values.** No command copies values from local files to the platform. Shelved by Will on 2026-11-05.
- **Carried secrets.** A root `secret()` field, read from the app secrets and set on a service by the deploy, belongs to the module-input project (S18).
- **A typed platform secret.** `schema` exists on `variable()` only, not on `variable.secret()`. A secret's text is checked by its `secret(inner)` field at boot.
- **Removing `envSecret()` and `envParam()`.** This project deprecates them. Removing them is a later change.
- **Validating on the platform.** Composer validates; the platform never will.
- **A graph edge or a topology entry for "a service reads a variable".** Recorded in [deferred.md](deferred.md).
- **Scope on the node.** Where a value lives (project class, branch or service) is the operator's choice on the platform; the node never says it. An author-declared per-reader variable is recorded in [deferred.md](deferred.md).

## Place in the larger world

- **Module input** ([../module-input/design.md](../module-input/design.md)) defines runtime values, pointers, `field()` and the secret field, which a platform variable's value is bound through. Before its S18 ships, the secret field is `secretString()`; after, `secret(inner)`. This project does not depend on S18.
- **The Prisma Cloud target** (`packages/1-prisma-cloud/1-extensions/target`) holds the nodes, the graph check, the serializer, preflight and the boot reader.
- **Core** (`packages/0-framework/1-core/core`) gains `appRoot()` in S1, the root constructor, and three things in S2: the `provision()` overload on `appRoot()` that alone accepts a platform variable node; a resource that is a value, which `provision()` returns stamped with the address and with `id` on it; an extension's graph check hook that runs after Load; and preflight findings that the CLI prints (design sections 4, 5 and 9).
- **The local target** (`packages/1-prisma-cloud/0-lowering/local-target`) fills and isolates variables under `prisma dev`.
- **One shared package** below the target and the local target holds the marker format, the decoding rule, the validator call and the error text (design section 7).
- **The Management API** provides the variable rows Composer lists, by project, class, branch and key.
- **Running Alchemy in Composer's own process** is planned separately. It does not affect this project.

## Cross-cutting requirements

1. The loaded graph holds every platform variable node, the services that read each one, and its JSON Schema, without deploying.
2. The deploy never creates or changes a platform variable's value, never reads one, and fails for a missing one only when a service's schema shows the service cannot boot without it.
3. Boot never decodes a variable's text in a way the author did not declare.
4. A platform secret's text is never printed: not at deploy, not at boot, not by `prisma dev`, and not through a parser's or validator's message.
5. `prisma dev` and boot apply the same decoding and validation, from one implementation, with the same messages.
6. Every decision record and glossary entry the project changes is rewritten as one current record in the PR that changes the behaviour, and no two slices rewrite one record at the same time.
7. Every rule that depends on a platform behaviour is checked against the platform before the code that depends on it is written (design section 3, "Not yet checked").

## Transitional-shape constraints

- Before S3, `schema` does not exist, and every platform variable's value is text.
- Before module-input S18, a platform secret binds to a `secretString()` field.

There is no window in which `envSecret()` and `variable.secret()` follow different rules: S2 changes both at once.

## Definition of done

- An app whose root is `appRoot()` and uses `variable()`, `variable.secret()` and `schema` deploys to Prisma Cloud with one optional variable unset, and the deploy report lists that variable with the command that sets it. With a required variable unset, preflight refuses the deploy naming the variable and the field, before anything is created. Setting it with `prisma project env add` and deploying again starts the service with the value decoded and validated.
- A fresh preview branch of that app deploys with its values from a preview-wide row, and a value set on one service alone is seen by preflight for that service.
- A nested module that calls `provision(variable(…))` fails to compile, and an app whose entry is still `module()` deploys with a warning that says to use `appRoot()`, and its body cannot provision a platform variable.
- The same app runs under `prisma dev` with its values in `.env.dev`, and a value that fails its `schema` stops `prisma dev` with boot's message.
- `envSecret()` deploys without preflight writing anything to the platform.
- A planted secret decoded under a number schema produces an error that holds no part of the secret.
- The examples and guides use the nodes, not the shortcuts.
- The five platform checks in design section 3 have recorded answers in ADR-0064.
- ADR-0064 exists, and ADR-0029, 0032, 0042, 0058, 0062, 0063, the glossary, the domain map and the goals match the code.

## Open questions

None for Will. Engineering choices left to the slices: the JSON Schema validator and its `format` behaviour (S3 spike), and the five platform checks (S2).

## References

- Design discussion with Will, 2026-11-05 and 2026-11-06, recorded in [design.md](design.md). Reviews applied on 2026-11-06: `wip/pv-review/`; the root construct and the API settled the same day in `wip/pv-review/decisions-round-2.md`.
- [ADR-0029](../../../docs/design/90-decisions/ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md), [ADR-0032](../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md), [ADR-0042](../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md), [ADR-0058](../../../docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md), [ADR-0062](../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md), [ADR-0063](../../../docs/design/90-decisions/ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md).
- [Standard JSON Schema](https://standardschema.dev/json-schema).
