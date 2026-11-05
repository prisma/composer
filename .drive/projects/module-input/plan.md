# Module input: plan

**Design:** [design.md](design.md), which is authoritative. **Spec:** [spec.md](spec.md).

A PR delivers one capability a user would notice, so slices whose limits the next slice closes ship together. S9 and S10 ship as one PR, prisma/composer#412: every binding is checked against its schema, and only named fields pass on. S11, S12 and S13 ship as one PR: configuration from `.env` files is read once, in a fixed order, and no known secret is printed. A PR opens after the one before it has merged, so each builds on merged work. Each PR amends the decision records whose behaviour it changes, as design section 12 lists them, and adds its breaking changes to the release note.

## Where it stands

- **S1** is done: [slices/s1-spike/report.md](slices/s1-spike/report.md).
- **S2** is merged: prisma/composer#401.
- **S3 to S8** are merged as one PR: prisma/composer#403.
- **S9 and S10** are built and in review as prisma/composer#412.
- **S11 to S13** are built on the git branch `claude/module-input-s11-s13`, not yet opened as a PR, through three review rounds. Two changes are open before the PR: the known secrets become the values the graph names (S13 below), and the engine-based redaction of Alchemy's output goes, because Will dropped prisma/prisma-cli#383 on 2026-11-05. The PR then waits only for #412 to merge.
- **S18**, platform variables, was designed with Will on 2026-11-05 ([design.md](design.md) sections 5 and 7). It is specified next and built after S11 to S13 merge. It absorbs S15, S16 and S17.
- **S14** is designed with Will before it is specified.

## S1. Spike: an input field as an opaque typed value

Prove, outside production code, that a module body can receive `input` as an object whose property reads, nested ones too, each return a value typed from the schema's output; that Load can record which input field flows into which child binding or `resolve()` dependency; and that misusing one in the body gives a clear error naming the field. Done.

## S2. `module()` takes `input`

`module(name, { input }, body)`; the body receives `input` beside `deps`, `environment` and `provision`; `provision(module, { input })` binds it; Load checks the binding with the module's schema during its second pass; `resolve()` lists input fields. The old `params` and `secrets` slots keep working. Built; in review as prisma/composer#401.

## S3. `envParam()` and `envSecret()` are values

Both return values, and so do `generatedParam()` and `serviceOrigin()`. Deploy preflight checks every `envSecret()` in the graph, `resolve()` dependencies included. Built on `claude/module-input-s3`. It also lets a `resolve()` function receive and return a pointer, and ships `isRuntimeValue()`; S8 removes both.

## S4. Config adapters and the root's input

The `config` and `secrets` lists on the `composer` section, each defaulting to `[environmentVariables()]`; `dotenv()`; the root declares `input`, bound to the app configuration and checked before anything is created; `envParam()` reads the app configuration; deploy and dev preflight fill `envSecret()` from the app secrets. Built on `claude/module-input-s4`. It names the app configuration and the app secrets "pools" in code, lists `dotenv()`'s four files itself, and has the second process run the adapters again; S11 and S12 change these.

## S5. Migrate and remove the old slots

`auth()`, `email()` and every example move to `input`; `params`, `paramNeed()`, `secrets` and the module form of `secret()` are removed. Guides, the agent skill and the website. Built on `claude/module-input-s5`.

## S6. `field()` and the two kinds of pointer

A pointer records its kind, secret or plain, in its data. Load, preflight and the serializer recognise a pointer by its brand and the variable it names, never by object identity, so a copy made by ArkType still counts. `RuntimeValue<T>` and the public `Pointer` type ship, with `isPlainPointer()` and `isSecretPointer()`. `@prisma/composer/arktype` gains `field()`, and a new `@prisma/composer/zod` exports `field()` and `secretString()`. `field(inner)` accepts `In | Pointer<In>`, outputs `Out | Pointer<In>`, and accepts only plain pointers; `secretString()` accepts a secret box or a secret pointer. Type tests cover both libraries, and message tests show that a wrapped field reports the plain field's error for a missing field and a wrong type, never naming a Composer class. The glossary gains `field()` and `RuntimeValue`, the Value entry is rewritten, and "Configuration — params and their sources" is renamed "Input". Nothing in the deploy binds a pointer to a wrapped field yet.

## S7. Schemas see pointers at deploy

`envSecret()`, `serviceOrigin()` and `generatedParam()` are typed as `RuntimeValue`s, so S8's compile error has the types it needs. A module's schema and a service's schema are checked at deploy with pointers in place of runtime values, and the stand-in values go, with `paramSource()`'s `sentinel` option. `paramSource()`'s `redacted` option decides the pointer's kind. The deploy finds an ArkType service schema that loses a secret box by checking it a second time with a stand-in box, and refuses it naming the field. `service.input()` returns the schema's output with every pointer removed, and so do the testing helpers. The auth service's schema and the examples wrap every field bound to `generatedParam()` or `serviceOrigin()`, and the guide, the agent skill and the examples teach `field()` on leaf fields. The release note shows the breaking change to service schemas.

## S8. `resolve()` takes deploy-time values only

Listing a runtime value or a wrapped field in `resolve()` fails to compile, with a type error that says a dependency must be a deploy-time value. Load refuses a dependency whose real value is a pointer or contains one at any depth, naming the field and saying to declare it plain. `isRuntimeValue()` and Load's acceptance of a returned pointer are removed, along with the guide's text about them. The release note covers `isRuntimeValue()`.

## S9. `input` is a dictionary

The body's `input` carries a brand that every binding type refuses, so passing the whole `input` on fails to compile, for every module, not only the root. Load refuses it too, with an error saying the whole `input` of the module was passed on, and to pass its fields by name. The tests that assert a non-root module may forward its whole input are changed to assert the refusal.

## S10. A service's binding is typed from its schema

`provision(service, { input })` is typed from the service's schema's input type, with the mapping a module's binding uses. In that mapping `SecretString` and `Pointer` are leaves, so a `SecretBox` written in a binding fails to compile, and a `secretString()` field takes only a secret runtime value or a module's secret field passed on. The loose `InputBinding` type goes. Type tests show a wrong literal, an `envSecret()` in a text field and a `serviceOrigin()` in a plain field each failing to compile. The examples and guides are fixed where the new type rejects them, and the release note shows the breaking change.

## S11. `dotenv()` delegates to `dotenv-flow`

`dotenv()` calls `dotenv-flow`'s `listFiles` and `parse`, with the pattern `.env[.node_env][.local]` so `.env.defaults` is not read, and the `dotenv-flow` version is pinned. The file order is `dotenv-flow`'s, including skipping `.env.local` for the environment `test`. The release note tells projects to remove `import 'dotenv/config'` when they adopt `dotenv()`, and the storefront-auth example does so if it adopts `dotenv()`.

## S12. The second process reads a configuration file

The first process writes a configuration file beside the generated stack file, mode 0600, holding the root's real values at the paths its body names and the values of the names `envParam()` reads. It deletes the file when the deploy ends, whether it succeeds or fails. The deploy's and `destroy`'s second processes read the file and run no adapter, and do not run the root's schema again. The first process passes the list of node addresses it checked, and the second process refuses to deploy a different graph. `prisma dev`'s second process reads the same kind of file, and receives the app secrets its local services need through its environment, never through a file. The "pool" names in code take the names "the app configuration" and "the app secrets", and the glossary's pool and adapter entries are replaced by "the app configuration", "the app secrets", "config adapter" and "secrets adapter".

## S13. Composer redacts every secret it knows

Everywhere Composer prints, it redacts every known secret, at any length. The known secrets are the values of the app secrets under the names the graph reads: today the names `envSecret()` passes, and from S18 the root's `secret()` field names too. A value in the app secrets that nothing names is not read and not a secret, so the recommended `secrets: [dotenv(), environmentVariables()]` redacts nothing it should not. (The first build counted every value a written `secrets` list returned; with the recommended setup that refused every root input field and blanked every `1` in the output, review finding F16. Will ruled on 2026-11-05 that the pools are what Composer may carry, read only at the root's boundary.) That covers errors, adapter failures and the second process's failure cause. The second process's own output is not redacted: that needed an engine change (prisma/prisma-cli#383), dropped because the Alchemy integration moves to the programmatic API soon, which removes the second process. An end-to-end test searches the configuration file, the stack file, the deploy report, the errors and the second process's output for a known secret value. Manual QA of the examples against real targets, including a root `input` from `.env.<environment>` in `prisma deploy` and `prisma dev`.

## S14. `prisma dev` watches its inputs

Adapters may report that their values changed, and `dotenv()` watches its files. `prisma dev` applies the new values instead of pausing. Designed and specified after S13.

## S15, S16 and S17 are absorbed by S18

S15 (a developer's local secret reaching another environment) is settled because the deploy no longer fills platform variables. S16 (secrets get a home of their own) is settled because only the values the root names are known secrets. S17 (`secret(schema)`) ships inside S18, because platform secrets and carried secrets both need it.

## S18. Platform variables are nodes, and the root's input may hold a secret

Design: [design.md](design.md) sections 5, 7, 8 and 9, settled 2026-11-05. One PR, after S11 to S13 merge.

- `@prisma/composer-prisma-cloud` exports `platformVariable({ name, parse? })` and `platformSecret({ name, parse? })`, resources whose `value` is a runtime value. The Prisma Cloud target creates a subscription of each service to each variable its input points at, and sets no value. The deploy report lists the variables with no entry on the platform. The local target fills a platform variable from the local pools under its `name`, and validates the value against `parse`.
- `parse` takes a Standard JSON Schema; its `jsonSchema.input()` travels in a `$platform` marker in the input document; Load refuses a transforming or unencodable schema, and two nodes for one `name` with different schemas. Boot decodes the text as JSON unless the schema's type is `string`, validates it against the JSON Schema with a validator Composer ships, then hands it to the service's schema. The platform validates nothing.
- `secretString()` becomes `secret(inner)`, in both entry points.
- A root `secret()` field is filled from the app secrets and reaches the second process in `PRISMA_COMPOSER_NAMED_SECRETS`; the deploy sets it on the service as a secret variable. A name in both pools for a root field fails the deploy. `destroy` binds it to a stand-in box.
- Preflight stops filling platform variables on deploy and dev. The Prisma Cloud target stops stripping a service's environment at boot: a service sees the project's variables plus what Composer sets on it directly. The local target keeps giving each service only what its input points at.
- `envSecret()` and `envParam()` are deprecated as shortcuts.
- The slice decides whether the deploy writes the resolved binding instead of the schema's output into the input document, so a transforming `field()` schema works for a literal.
- Decision records rewritten in full: ADR-0029, ADR-0032, ADR-0042, ADR-0058 and ADR-0062. New glossary entries: platform variable, platform secret, subscription, carried secret, known secrets.
- Breaking: `secretString()` removed; preflight no longer fills a variable, so a project that relied on `deploy` seeding `envSecret()` values sets them on the platform instead.

Nothing in it waits for the platform. When the platform ships subscriptions, the target records each service's subscriptions and the "not set" report comes from the platform instead of the project's variable names.

## Close-out

- [ ] Verify every condition in the spec's definition of done.
- [ ] Move what is long-lived from `design.md` into `docs/design/`.
- [ ] Remove references to `.drive/projects/module-input/` elsewhere in the repo.
- [ ] Delete `.drive/projects/module-input/`.
