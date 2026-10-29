# Module input — plan

**Spec:** [spec.md](spec.md) · **Decisions:** ADR-0061, ADR-0062, [design-notes.md](design-notes.md)

Five slices, one PR each, in order. Each builds on the one before.

## S1. Spike: an input field as an opaque typed value

Prove, outside production code, that a module body can receive `input` as an object whose property accesses (nested ones too) each return a value typed from the schema's inferred output; that Load can record which input field flows into which child binding or `resolve()` dependency; and that reading, comparing or branching on one in the body gives a clear error naming the field. Answer how `provision(child, { input })` forwards the whole object, and how an optional field reads. The artifact is a short report with the probe code and its type tests. Builds on main.

## S2. `module()` takes `input`

`module(name, { input }, body)`; the body receives `input` beside `deps`, `environment` and `provision`; `provision(module, { input })`; the module's binding is validated by its schema at deploy after Load's second pass; `resolve()` over input fields. The old `params` and `secrets` slots keep working in this slice. ADR-0061 and ADR-0016 amendments, glossary, `module-composition.md`.

## S3. `envParam()` and `envSecret()` are values

Both return values. `envParam()`'s real value is the variable's value at deploy; `envSecret()`'s is the pointer, which throws when used as text. A `resolve()` may list either and may return a pointer it received. `isRuntimeValue()`. Preflight checks every `envSecret()` in the graph, `resolve()` dependencies included. ADR-0029, ADR-0032 and ADR-0062 amendments, `config-params.md`.

## S4. Config adapters and root input

`config` and `secrets` on the `composer` section, each defaulting to `[environmentVariables()]`; `dotenv()`; the root declares `input`, filled from the `config` pool and validated before anything is created, in `prisma deploy`, `prisma dev` and the generated stack files; `envParam()` reads the `config` pool; deploy and dev preflight fill `envSecret()` from the `secrets` pool. ADR-0049 and ADR-0062 amendments, `deploy-cli.md`, `local-dev.md`.

## S5. Migrate and remove the old slots

`auth()`, `email()` and every example move to `input`; `params`, `paramNeed()`, `secrets` and the module form of `secret()` are removed. Guides, the agent skill and the website. Manual QA of the examples against real targets, including a root `input` from `.env.<environment>` in `prisma deploy` and `prisma dev`.

## Close-out

- [ ] Verify every condition in the spec's definition of done.
- [ ] Move what is long-lived from `design-notes.md` into `docs/design/`.
- [ ] Remove references to `.drive/projects/module-input/` elsewhere in the repo.
- [ ] Delete `.drive/projects/module-input/`.
