# Platform variables: plan

Spec: [spec.md](spec.md). Design: [design.md](design.md).

## Status

Planned 2026-11-06, replanned the same day after three reviews and the root-construct decision. No slice started.

## Order

```text
S1 (appRoot) ── S2 (the node, the shortcuts, no seeding) ── S3 (schema)
```

Three slices, one after the other. S1 ships the root constructor alone: it is a breaking change every app feels, it stands on its own, and it keeps S2 reviewable. S2 ships the node and makes every operator variable, the shortcuts included, follow its rules in one PR, so that no two rules for one platform row ever coexist on `main`. S3 starts after S2 has merged, so no two slices rewrite one decision record at the same time. No slice depends on module-input S18.

## S1. The root is written with `appRoot()`

Builds on: main. Hands to: S2 a root whose body context is typed differently from a nested module's, so S2 can add the one `provision()` overload only the root has.

- `appRoot(name, { input? }, body)` in `@prisma/composer`: what `module()` takes minus `deps` and `expose`. Its result is a root node that `provision()` refuses by type. The deploy and `prisma dev` load only a root node, and fail Load with a message naming `appRoot()` for an entry that is a `module()`. Compile-time in this slice: no `deps` or `expose` on the root, and no nesting of a root (design section 4).
- Every example's root and every guide's root change `module(` to `appRoot(`; the agent skill too.
- Glossary: the Module entry's "there is no separate root construct" is rewritten (design section 14). ADR-0016 and ADR-0061 say the root is written with `appRoot()` where they show a root.
- The release note: the `module(` to `appRoot(` change, before and after.
- QA: a `module()` entry fails Load with the `appRoot()` message; `provision(appRoot(…))` fails to compile.


## S2. A platform variable is a node, and the deploy fills nothing

Builds on: S1 merged. Hands to: S3 a node whose value reaches a service through a `$platform` marker, with nothing filled on the platform and every shortcut following the same rules.

### Platform checks, done first

Each answer is recorded in ADR-0064 before the code that depends on it is written (design section 3, "Not yet checked"):

1. Whether the platform stores an empty value and delivers it as empty text. Decides the empty-text rule in design section 8.
2. Whether the platform keeps a key's case. Decides what the release note tells a project with lower-case `envSecret()` names.
3. Whether `prisma project env add` can set a preview-class row with no branch. Decides the command the report and the release note give.
4. What the platform does when a deployment's process exits at boot. Decides what the guide says about a boot failure, and whether a wait before promotion goes into deferred.md.
5. How the Management API lists a row set on a service, and whether it carries `updatedAt`. Decides whether preflight's existence check covers all three scopes or only project and branch.
6. Which names a fresh project marks `isManagedBySystem`. Adds any fixed ones to the reserved names.

### Core

- `appRoot()`'s body context gains the one `provision()` overload that accepts a platform variable node; `module()`'s does not. The no-`field()`-at-the-root rule stays a Load check (design section 4).
- A resource node may be a value: the target builds it as a source at construction, `appRoot()`'s `provision()` returns it with the provisioned address stamped into the pointer's data and `id` set on it, and only a resource that provides no contract may be one (design section 4).
- A graph check hook an extension registers, run right after Load in `prisma deploy`, `prisma dev` and `destroy` (design section 5).
- Preflight returns findings the CLI prints after the preflight step and repeats in the deploy report; the `report` contract changes from counts only (design section 9).

### Prisma Cloud target

- `variable({ name })` and `variable.secret({ name })`, each building its source at construction, with a descriptor that provisions nothing, and the default id rule. `provision(variable.secret(…))` is `RuntimeValue<SecretString> & { id }`, bound to `secretString()` until module-input S18 ships; a plain value in a `secret()` field, or a secret in a `field()` field, fails to compile.
- The constructor refuses a name that is not upper case, a `COMPOSER_` name, `DATABASE_URL`, `DATABASE_URL_POOLED`, `PORT`, `PATH`, `HOME`, and any fixed name check 6 adds.
- The graph check refuses: two declarations of one name inside the root, across both forms; one name with two meanings across root fields, `envParam()`, `envSecret()` and the nodes; a value in a `resolve()` dependency, a resource's props, per-key params, the whole input or a plain field; and `envSecret()` below the root, each with the message design sections 4 to 6 and 12 give.
- The reads relation: the list of platform variables each service reads, from the stamped addresses, grouped by variable for the report and errors.
- The serializer writes the `$platform` marker for the nodes and for `envSecret()`; `$secret` goes; the key escape covers `$platform`; the distinct-name check applies to `$generated` only; a marker shows as `$platform NAME` in the report.
- Boot: the four steps in design section 8, the array-position rule, the empty-text rule as check 1 selects, and errors that never hold the text.
- Preflight: existence at every scope a reader resolves from, project class, branch and the reader's own service as check 5 allows; reads in parallel, at most eight at a time; fills nothing; refuses a row marked `isManagedBySystem`; refuses the deploy for a required variable with no row by the ADR-0058 method; reports the optional ones with the command from check 3; triggers carry `updatedAt` or `?`.
- `envParam()` per-key params: no filling; an unset pointed param takes its default or is left out when optional; the boot message says to set the variable on the platform.
- `envSecret()` and `envParam()` marked deprecated.

### Shared package

- One module below the target and the local target holding the marker format, the decoding rule (text only in S2), the validator call (none yet) and the error text. The local target's copies of the marker constants go.

### `prisma dev`

- The local target fills plain platform variables from the app configuration and platform secrets from the app secrets; refuses a non-text configuration value; collects `$platform` markers at any depth for isolation; hands plain values through the app configuration file and secret values through `PRISMA_COMPOSER_NAMED_SECRETS`; applies the missing-value rule of ADR-0058 and the empty-text rule check 1 selects; treats platform secrets as named and known secrets; restarts a service when a value changes.

### Examples, guides and records

- Examples `email`, `auth`, `storefront-auth` and `env-param` move to the nodes; credential fields get non-empty schemas if check 1 makes empty text a value.
- The building-an-app and deploying guides and the agent skill show the nodes, the mental model (name, readers, schema; the operator chooses scope), the one line about why only the root owns them, and where a boot error appears per check 4.
- ADR-0064 written. ADR-0029, 0032, 0042, 0058, 0062 and 0063 rewritten in full. Glossary: new entries for platform variable and platform secret; Module (the App entry, for `appRoot()`), Core nouns, Resource, Topology, Address and logical ID (the name-as-identity exception), Input, Value, RuntimeValue, The app configuration, The app secrets, Secrets key, Named secrets and Known secrets rewritten. Domain map, the goals and the address principle amended. All as design section 14 lists.
- The release note: each change in design section 13, before and after, the preview-wide step first.

### QA on Prisma Cloud

- A required variable unset: preflight refuses, naming it. An optional one unset: the deploy succeeds and the report lists it. Set, then changed: only the readers redeploy.
- `envSecret()` deployed before and after, showing nothing written to the platform.
- A fresh preview branch deploying with a preview-wide value, and a value set on one service alone, seen by preflight and received by that service only.
- A nested module calling `provision(variable(…))` fails to compile; a `module()` entry fails Load with the `appRoot()` message.
- A secret planted in a value and a search of the deploy output, the report, the stack file and the boot error for any part of it.

## S3. `schema`

Builds on: S2 merged. Hands to: nothing; closes the type requirement.

### Spike, done first

- The JSON Schema validator against ArkType's and Zod's output for the guide's types: draft 2020-12, no `new Function`, no Node or Bun dependency, `$ref` and `$defs`, whether `format` is checked, and every message it can produce (design section 7).

### Build

- `schema` on `variable()`, typed so the provisioned value is `RuntimeValue<T>` from the schema's output type.
- The constructor computes both JSON Schemas, catches what the library throws, refuses a transforming or mixed schema, decides text-only or never-text, strips annotations, and keeps the result in the node's props.
- The serializer writes `schema` into the marker; the report shows `$platform NAME (type)`.
- The shared package gains the decoding rule, the safe-integer check and the validator call; boot and `prisma dev` use them, with errors that name the variable and the expected form or the failing keyword and location, never the text.
- ADR-0064 and ADR-0042 rewritten for `schema`; the glossary entry gains it; the guide's section on what Zod and ArkType lose, the `format` choice, and identifiers as text.
- QA on Prisma Cloud: a number, a boolean, an enum and an object variable; a bad value failing boot, and where its error appears.

## Close-out

- [ ] Verify every condition in the spec's definition of done.
- [ ] Move what is long-lived from `design.md` into `docs/design/` (ADR-0064 and the domain docs).
- [ ] Remove references to `.drive/projects/platform-variables/` elsewhere in the repo.
- [ ] Delete `.drive/projects/platform-variables/`.
