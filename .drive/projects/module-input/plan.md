# Module input: plan

**Design:** [design.md](design.md), which is authoritative. **Spec:** [spec.md](spec.md).

Each slice is one PR. A slice's PR opens after the slice before it has merged, so each builds on merged work. Each PR amends the decision records whose behaviour it changes, as design section 12 lists them, and adds its breaking changes to the release note.

## Where it stands

- **S1** is done: [slices/s1-spike/report.md](slices/s1-spike/report.md).
- **S2** is built and in review as prisma/composer#401.
- **S3, S4 and S5** are built, on the stacked branches `claude/module-input-s3`, `claude/module-input-s4` and `claude/module-input-s5`. They were built against an earlier version of the design. They merge as built, in order, and S6 to S13 change what they built to match `design.md`.
- **S6 to S13** are not built.
- **S14 to S16** are designed with Will after S13. The earlier plan called S14 and S15 "S6" and "S7".

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

Everywhere Composer prints, it redacts every value under a name an `envSecret()` in the graph names, in the app configuration or the app secrets, and every value a project's own secrets adapters return when it writes a `secrets` list, at any length. That covers errors, adapter failures, the second process's failure cause, and the second process's output, which Composer now reads through a pipe, holding back enough characters to catch a secret split across two chunks. An end-to-end test searches the configuration file, the stack file, the deploy report, the errors and the second process's output for a known secret value. Manual QA of the examples against real targets, including a root `input` from `.env.<environment>` in `prisma deploy` and `prisma dev`.

## S14. `prisma dev` watches its inputs

Adapters may report that their values changed, and `dotenv()` watches its files. `prisma dev` applies the new values instead of pausing. Designed and specified after S13.

## S15. A developer's local secret does not reach another environment

Design a solution for this case: deploying production from a machine whose `.env.local` holds a test key fills a missing production variable with that key. Designed with Will after S13.

## S16. Secrets get a home of their own

Give secrets a home distinct from plain values, so a `.env` file no longer mixes the two, and redaction stops covering the plain values that share a file with secrets. Designed with Will after S13.

## S17. A secret field wraps its schema, as `field()` does

`secretString()` becomes `secret(schema)`, following the `field()` pattern: `secret(type('string'))` for ArkType and `secret(z.string())` for Zod. The wrapped schema checks the secret's content at boot, when the real value exists; at deploy the field accepts a secret pointer or a secret box. The name is settled when the slice is designed. `secretString()` is removed, which is a breaking change for every schema with a secret field. Designed after S16.

## Close-out

- [ ] Verify every condition in the spec's definition of done.
- [ ] Move what is long-lived from `design.md` into `docs/design/`.
- [ ] Remove references to `.drive/projects/module-input/` elsewhere in the repo.
- [ ] Delete `.drive/projects/module-input/`.
