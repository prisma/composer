# 2. The deploy stops copying local values

Parent: [project spec](../../spec.md), [plan](../../plan.md) section 2, [design](../../design.md) sections 3, 5, 6, 8 to 13. Grounding against the code on 2026-11-06: `wip/pv-review/slice2-grounding.md`.

## 1. At a glance

```ts
// module.ts
export default appRoot('shop', ({ provision }) => {
  provision(emailService(), {
    input: { from: 'shop@example.com', apiKey: envSecret('EMAIL_API_KEY') },
  });
});
```

```sh
$ prisma deploy
✔ check environment variables
Platform variables with no value:
  - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview --branch 'staging'
```

- The deploy does not copy local values to platform variables, because an implicit copy can push a local value into a remote environment by accident. An explicit way to set variables through `deploy` is expected later (deferred.md). Today preflight copies a missing `envSecret()` value from the developer's `.env` to the platform; after this slice it only reads whether a row exists.
- A variable with no row fails the deploy only when a service cannot boot without it, decided from the service's schema and never from a value. One nothing needs is listed, after the preflight step and again in the deploy report, with the command that sets it. The deploy succeeds.
- Every operator variable that exists today, `envSecret()` and `envParam()`, follows one rule set: upper-case names, reserved names, one meaning per name, a `$platform` marker in the input document, four boot steps, existence at both scopes the platform offers, triggers on the resolved row's `updatedAt`, and the same rules under `prisma dev`.
- There is no node yet. `envSecret()` is the only way to name a platform secret, and every value is text. Slice 3 adds the node under these rules, so no platform row ever follows two rule sets on `main`.

This slice is one review because it is one rule change: every rule here is about the same thing, what Composer does with an operator's variable, and shipping half of them would leave two rule sets live at once. It is breaking, and the release note says how to move.

## 2. Chosen design

Each subsection names the design section it builds and the engineering choices made here. A choice is marked **(decided here)** where the plan left it open or the code made the plan's wording wrong.

### 2.1 The graph check hook

Design section 5. Core's `ExtensionDescriptor` gains an optional `checkGraph(graph: Graph): void`. The CLI's `runPipeline` calls every extension's `checkGraph` right after Load and before registry coverage, so it runs in `prisma deploy`, `prisma dev` (first start and every rebuild) and `destroy`, and never in `log`, which does not run Load. The hook refuses a graph by throwing core's `GraphCheckError`, which fails the command as `COMPOSE.GRAPH_INVALID` with its message; nothing is created and no dev service starts. Any other throw is a bug (ADR-0044).

**(decided here)** The hook takes the loaded graph only. It has no access to the app configuration or secrets: a graph check is about the graph.

The Prisma Cloud extension registers one `checkGraph`. In this slice it enforces one meaning per name (2.2). Slice 3 adds the node rules.

### 2.2 Names

Design section 6. One checker in the Prisma Cloud target, `assertVariableName(name, factory)`, refuses a name that does not match `^[A-Z][A-Z0-9_]*$` and the reserved names `COMPOSER_…`, `DATABASE_URL`, `DATABASE_URL_POOLED`, `PORT`, `PATH` and `HOME`, each with its reason from design section 6. `envSecret()` and `envParam()` call it at construction and lose their duplicated copies, so Load fails with the checker's message. Slice 3's constructor reuses it. The messages follow today's shape, for example:

```text
envSecret name "api_key" is not a platform variable name: it must match ^[A-Z][A-Z0-9_]*$, an upper-case letter followed by upper-case letters, digits and underscores. The platform accepts only upper-case letters, digits and underscores in a key. Refusing a leading underscore, which the platform accepts, is Composer's own rule: shells and tools use names that start with an underscore for their own variables.
envSecret name "PORT" is reserved: boot sets PORT to the service's port.
```

**One meaning per name.** Core's Load already refuses a name read from the app configuration (`envParam()` in a binding or in per-key params, or a root input field) that another place names as a secret (`envSecret()`), because Composer writes plain values to a file and never a secret. **(decided here)** That check stays in core as it is: it protects core's own file rule, and it runs before any hook. The target's `checkGraph` adds the pair core does not refuse: one name used by `envParam()` and by a root input field. The error names both uses and both addresses. Two `envParam('X')`, or two `envSecret('X')`, in two bindings read one variable and stay allowed, as today. The slice updates `preflight.test.ts`'s "a name bound as a secret and as an env-sourced param is filled from the app secrets", which builds a graph Load refuses; it goes with seeding.

### 2.3 The shared package

Design section 7, "One implementation". **(decided here)** A new package `@internal/input-document` at `packages/1-prisma-cloud/0-lowering/input-document`, lowering layer, shared plane, with no dependencies and no Node or Bun import, on the model of `@internal/s3-protocol`, with its `architecture.config.json` entry. It holds:

- the marker constants and types: `$platform` with `{ name, secret? }`, `$generated`, the key escape (`^\$+(?:platform|generated)$`), and the param pointer prefix;
- `collectPlatformMarkers(document)`, which finds every `$platform` marker at any depth and returns `{ name, path, secret, inArray }`;
- the decoding rule, which in this slice is "the value is the text", and the boot error texts for a marker: a variable with no value in an array position, and the list of unset names appended to a schema failure.

The target's serializer, the service runtime's boot code and the local target import it. The local target's copies in `local-target/src/compute.ts` go, and `dev-pointed-variables.test.ts` keeps proving the two sides agree. The target's `invariants.test.ts` list of files that read `process.env` is updated for the moved code.

### 2.4 The input document

Design section 8. The serializer writes `{ "$platform": { "name": "X", "secret": true } }` where it wrote `{ "$secret": "X" }`. `$secret` is gone from the writer and the reader; the document and the boot code ship in the same package, so no compatibility reader exists. The `$`-key escape covers `$platform`, `$generated` and, so that an old user key still round-trips, `$secret`. The distinct-names check applies to `$generated` markers only; two `$platform` markers for one name in one binding are two reads of one variable and are allowed, and the tests that assert a collision for secrets change to assert the allowance. `InputDocumentRow.secrets` becomes `InputDocumentRow.markers`, every `$platform` marker the document holds with its name, path, `secret` and whether an array position holds it, because the compute descriptor builds triggers from it and both preflights name readers and array positions from it.

**(decided here)** The deploy report's `input` detail prints the document with each marker replaced by the text `$platform NAME` or `$generated NAME`, and no longer the marker's JSON. Slice 4 adds `(number)` for a typed one.

### 2.5 Boot

Design sections 8 and 12. `service.input()` follows four steps:

1. A marker whose variable has no value, meaning `process.env[name]` is undefined or empty, leaves its key out of its object. A marker in an array position cannot be left out: boot fails naming the variable and the path. **(decided here)** Empty means unset for a per-key `envParam()` pointer too; today an empty value reaches the schema. The two serializer tests that assert an empty value passes through change.
2. A marker whose variable has text takes the text. Slice 4 adds decoding and validation here.
3. A marker with `secret: true` puts the text in a secret box.
4. The service's own schema validates the whole object, as today. When it fails and at least one marker was left out in step 1, the error ends with the names of those variables, so the operator knows what to set. The service's schema message stays in the error, as today: every secret is boxed before the schema runs, so the message can hold no secret's text.

A per-key `envParam()` param whose pointed variable has no value takes the param's default, or is left out when the param is optional, and fails boot only when it is required. The error for a required one is:

```text
config param "<name>" (env <key> → <NAME>) has no value: set the platform variable "<NAME>" with prisma project env add.
```

Today it says "the deploy did not provision it", which stops being true.

### 2.6 Preflight

Design section 9. Preflight fills nothing: `fillMissing` and every test of it go. For each platform variable the graph names, preflight makes one list call filtered by `projectId`, `class` and `key`, which already returns the class row and the branch row, walks every page, and keeps the rows the environment sees: the class row, and for a preview environment its branch's row. **(decided here)** "Existence at both scopes" is that one call per name, not two.

- **Resolution.** The branch row wins when there is one, otherwise the class row. The `updatedAt` preflight hands back is that row's, so a change to a class row shadowed by a branch override triggers nothing. The two tests that assert "the newer row wins even when it is the template" change to assert this.
- **A system row.** A row the environment sees that carries `isManagedBySystem: true` fails the deploy, naming the variable: such a row is the platform's whatever its name. The page projection gains that field.
- **Concurrency.** The list calls run at most eight at a time. There is no helper in the repo; the target gains a small one. A failed list call fails the deploy, as today.
- **Required or reported.** For each service, preflight first serialises the input with every variable present and runs the service's schema; a failure there is an invalid input, reported as such and never blamed on a variable. Then it serialises with every variable that has no row left out and runs the schema again; if it passes, those variables are optional for that service. If it fails, each one alone is left out in turn, and the ones whose absence alone fails are required; when no single one fails alone, the service "needs some of them". A marker in an array position whose variable has no row is required without a check. This is the local target's `requiredSecrets` method, moved where both preflights can use it. **(decided here)** A per-key `envParam()` param is required when it has no default and is not optional, which is the boot rule in 2.5. **(decided here)** A secret a module's input names that no service reads has no reader to need it: it is reported, never required.
- **The error for a required variable** lists each one with its readers and the commands, and no service or database is created. Preflight runs after the deploy has resolved the Project and Branch, so a new app's first deploy creates those two and then stops here, with the project's id in the commands:

```text
Deploy failed. 1 platform variable a service needs has no value:
  - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")

Set it on the platform, then deploy again:
  - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
  - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview --branch 'staging'
```

  For production the one command is `--role production`. For every other environment the preview-wide form comes first and the branch form second, as design section 9 says.

- **The findings.** Preflight hands the CLI, through `PreflightInput.report`, the list of variables with no value that nothing requires, each with its readers (service address and field path, or the per-key param) and the commands. `PreflightInput.report` carries this list in place of counts; its doc comment "counts only: never a name or a value" becomes "names and readers only: never a value". **(decided here)** The CLI prints the list right after the preflight step as a block headed `Platform variables with no value:`, through a new event the human renderer prints and the JSON renderer carries; step data stays a flat record and keeps `checked` and `unset` counts. The CLI carries the list to the second process in core's own transport variable, and lowering puts it into `DeploymentResult.findings`, so the deploy report repeats it at the end under the same heading. The extension's own preflight payload does not carry it. `prisma dev` has its own rule (2.7) and prints nothing here.
- **Triggers.** Unchanged in shape: each service's deployment triggers carry `<name>:updatedAt` for each variable its document or its per-key params point at, and `?` for no row. With resolution as above, changing a value redeploys exactly its readers.

### 2.7 `prisma dev`

Design section 10. The local target collects `$platform` markers at any depth through the shared package and gives each service only the variables its own rows and markers point at, as today. A platform secret is filled from the app secrets under its name and reaches the second process in `PRISMA_COMPOSER_NAMED_SECRETS`, in memory, as today.

**(decided here)** The named secrets and the known secrets stay keyed by `secretsKeys(graph)`, every secrets key of the graph's secret sources. Design section 14 defines them through "the names the graph's secret sources use", and that is this set; it is a superset of the marker names only for a module-input secret no service reads, and redacting one more value is the safe side. The plan's sentence that names the markers is corrected in `plan.md`.

The dev preflight already follows the ADR-0058 method for secrets. It changes in one place: a per-key `envParam()` param whose variable is unset fails only when the param is required (no default, not optional), with the same wording rule as the deploy's error, and its test "a missing env-sourced param is a hard error naming the variable and service" changes to that. An empty value is unset. A changed value keeps today's behaviour: dev pauses rebuilds and asks for a restart, and after the restart the fingerprint trigger redeploys only the readers.

### 2.8 `envParam()` in a binding is deprecated

Design section 12. The JSDoc of `envParam()` gains `@deprecated` with the message "a root input field replaces envParam() in a binding; per-key params are unchanged", so editors strike it through. **(decided here)** Nothing else marks it: the repo has no deprecation convention, and a JSDoc tag is the one every TypeScript editor shows. Its behaviour does not change in this slice beyond 2.5 and 2.6.

### 2.9 Records

Design section 14, slice 2. Each is rewritten in place as the current statement, with no supersession note.

- **ADR-0064, new.** **(decided here)** Its file is `ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md`, and `design.md` section 14 is corrected to that title, because a record titled "a platform variable is a node" would be false on `main` until slice 3 merges, and the chosen title stays true after it. It records the platform facts of design section 3, the graph check hook, the name rules, the `$platform` marker, the four boot steps, the preflight rules and findings, the `prisma dev` rules and the shortcuts' status, as they apply to every operator variable. Its line goes into `docs/design/90-decisions/README.md`.
- **ADR-0029 and ADR-0062:** preflight fills nothing. **ADR-0032:** an unset pointed param takes its default or is left out when optional. **ADR-0042:** the `$platform` marker, distinct names for `$generated` only, the four boot steps, empty means unset, the array-position rule. **ADR-0058:** isolation is a local-target rule, and the input a service receives under `prisma dev` and on the platform now agrees for an unset optional secret: the key is absent. Dev's document leaves the marker out; the deploy's document holds it, and boot leaves the key out.
- **Glossary:** The app configuration, The app secrets, Secrets key, Named secrets and Known secrets say nothing fills a platform variable, and define each set through the names the graph's secret sources use.
- **Purpose, `goals.md`:** a new environment needs its platform variables set first, and preflight names every one a service needs before any service or database is created.
- **Doc comments** on `PreflightInput`, `AppSecrets` and `NamedSecrets` in `core/src/control/app-config.ts` stop saying preflight fills.
- **Guides:** `docs/guides/deploying.md` (the seeding paragraph, the step list), `docs/guides/building-an-app.md` (the `envParam`/`envSecret` section), `docs/design/10-domains/deploy-cli.md`, and `skills/prisma-composer-core-concepts/SKILL.md`. The deploy guide says in one sentence that a service that fails at boot on the platform is still reported running and promoted, and names `prisma service logs <service>` as where the error is.

### 2.10 The release note

In the PR description, a before and after for each: the one-time step first, creating a preview-wide value with `--role preview` for every name the project seeded; the deploy no longer creates a variable; it fails for a missing variable only when a service needs it; names are upper case, and `PORT`, `PATH` and `HOME` are reserved; a lower-case name, which only ever worked in `prisma dev`, is renamed; a leading-underscore name is renamed after its row is created under the new name in every scope that has one; an unset per-key `envParam()` with a default boots; empty means unset; `envParam()` in a binding is deprecated.

## 3. Expected behaviour

Everything below is observable without reading the code.

- `envSecret('api_key')`, `envParam('_TOKEN')`, `envSecret('PORT')` each fail Load with a message naming the rule. `envParam('X')` in a binding and `X` as a root input field fail Load naming both.
- A service whose input holds `envSecret('X')` serialises to a document holding `{ "$platform": { "name": "X", "secret": true } }`; two such leaves in one binding are allowed; a user key `$platform` round-trips as `$$platform`.
- At boot with `X` unset: a required field fails the schema and the error ends with `X`; an optional field is absent and the service runs; an array position fails naming `X`. With `X=""`: the same as unset. With `X=abc`: the field holds a secret box of `abc`.
- A per-key `envParam()` param with a default boots with the default when its variable is unset or empty.
- `prisma deploy` with `X` unset: when a service requires it, the deploy fails after the preflight step with the error in 2.6 and the platform's rows are unchanged; when nothing requires it, the deploy succeeds, the block "Platform variables with no value" prints after the preflight step and again at the end of the report, and the rows are unchanged. Composer writes to `/v1/environment-variables` only its own `COMPOSER_` rows and the `DATABASE_URL` and `DATABASE_URL_POOLED` placeholder rows ADR-0048 records, never a name the app reads.
- With a preview-wide row made with `--role preview`, a fresh preview branch deploys with the value, and the service receives it.
- Setting `X`'s branch row and deploying again replaces exactly the deployments that read `X`. Changing the class row while a branch row exists replaces none.
- A row with `isManagedBySystem` under a name the app reads fails the deploy naming it.
- `prisma dev` with a required secret unset stops before any service starts, naming it; with an optional one unset, the service's document leaves the key out, as the deploy's would; a service receives only the variables its own markers and rows name.
- A secret planted in `.env` and in a value: the deploy output, the deploy report, the stack file and every error hold no part of it.

## 4. Scope

### In

- Core: `checkGraph` on `ExtensionDescriptor`, called from `runPipeline`; the preflight contract's findings in place of counts; the new CLI event and both renderers; the transport carrying the findings to the deploy report.
- The Prisma Cloud target: the name checker, the graph check, the serializer, boot, preflight, the compute descriptor's `input` detail and triggers, `envParam()`'s deprecation tag.
- The shared package `@internal/input-document` and the local target's move onto it.
- The local target and `prisma dev`: the per-key param rule, empty means unset.
- Tests: every test the grounding report names as asserting the old behaviour changes with it; new tests for each rule in section 3, including a planted-secret test for deploy and boot errors.
- Records, guides, skill and release note as 2.9 and 2.10 list them. `design.md` section 14's ADR-0064 title, and `plan.md`'s named-secrets sentence, corrected.

### Out

- The node, `variable()` and `variable.secret()`. Slice 3.
- `schema`, decoding beyond text, the validator. Slice 4.
- Removing `envSecret()` or `envParam()`; deprecating `envSecret()`. Slice 3 deprecates it once the node exists.
- Carried secrets and `secret(inner)`. Module-input S18.
- Any platform change, and anything about a process that exits at boot on the platform.

## 5. Done when

CI is green, `/drive-code-review` has run on the slice with its findings fixed, and manual QA shows, against Prisma Cloud with a repository example: an `envSecret()` a service requires, unset, refused by preflight before any service or database is created, with the rows listed before and after unchanged; one nothing requires, unset, with the deploy succeeding and the two lists printed; set, then changed on its branch row, with only its readers redeployed; a fresh preview branch deploying with a `--role preview` row; a planted secret found in no output; and under `prisma dev`, a required secret unset stopping dev before any service starts, and a service receiving only its own variables.

## 6. Open questions

None. The choices marked **(decided here)** are engineering decisions inside the design; the design itself is unchanged except the ADR-0064 title.

## 7. References

- Design: [../../design.md](../../design.md) sections 3, 5, 6, 8 to 14. Grounding: `wip/pv-review/slice2-grounding.md`.
- `packages/0-framework/3-tooling/cli/src/pipeline.ts`, `operations/execute-deploy-destroy.ts`, `operations/execute-dev.ts`, `family/commands/deploy.ts`, `render-deployment.ts`, `app-configuration-file.ts`.
- `packages/0-framework/1-core/core/src/control/app-config.ts`, `preflight-transport.ts`, `resolve-values.ts` (the plain-or-secret check), `graph.ts` (`secretsKeys`).
- `packages/1-prisma-cloud/1-extensions/target/src/`: `secret.ts`, `param.ts`, `serializer.ts`, `compute.ts`, `preflight.ts`, `preflight-names.ts`, `local-target/preflight.ts`, `descriptors/compute.ts`, `control/extension.ts`, `control/preflight-payload.ts`, `__tests__/invariants.test.ts`.
- `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`; `packages/1-prisma-cloud/0-lowering/s3-protocol` as the model for the shared package; `architecture.config.json`.
- ADR-0029, 0032, 0042, 0058, 0062; `docs/design/03-domain-model/glossary.md` lines 249 to 269; `docs/design/00-purpose/goals.md`; `docs/guides/deploying.md`, `building-an-app.md`; `docs/design/10-domains/deploy-cli.md`; `skills/prisma-composer-core-concepts/SKILL.md`.
