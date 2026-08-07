# ADR-0044: Errors are structural envelopes with dotted namespace codes

## Decision

Composer adopts the shared CLI error foundation from prisma/prisma (its ADR 239
lineage), duplicated verbatim into `@internal/foundation` pending extraction
into a shared package:

- Every user-surfaced failure is a **`CliStructuredError`**: `code` is a dotted
  `NAMESPACE.SUBCODE` string, `message` is the summary, and the optional
  `why`/`fix`/`where`/`meta`/`docsUrl` fields complete the envelope
  (`toEnvelope()` serializes it). The namespace prefix IS the error's category —
  there is no separate `domain` field.
- **Errors are structured at their origin — there are no catch-all codes.** A
  library type meant to surface (core's `LoadError`, assemble's
  `AssembleError`, a config-evaluation failure, an I/O failure the tool can
  name) is a structured error where it is raised. Site-specific wraps of
  foreign causes (an extension hook, the environment) are legal; boundary
  fallbacks like "pipeline failed" are banned.
- **Bugs carry no code.** A non-structured error reaching a process boundary is
  by definition a bug: the CLI prints `Error: <message>` plus a report hint and
  exits 1. `InternalError` marks known invariants; nothing maps bugs onto the
  user-facing taxonomy.
- **Recognition is structural, never nominal.** `CliStructuredError.is()`
  duck-types on `name`/`code`/`toEnvelope`, so copies of the class in
  different packages and processes interoperate. Subclasses (`LoadError`,
  `AssembleError`) must not override `name`.
- **Operation results ride one discriminator: `ok`.** The `./control`
  operations return the shared `Result` shape —
  `{ ok: true, value } | { ok: false, failure }` — with `CliStructuredError`
  as the failure. Bespoke per-operation outcome enums are banned; the success
  payload's type carries the operation-specific shape. A `Result` is
  in-process only (frozen, getter-backed; not JSON-serializable).

## The closed namespace list

Namespaces are closed and concern-shaped; each has one owning module (which may
delegate). Namespaces raised below the CLI layer are legal — codes are
vocabulary, not import edges.

| Namespace | Concern | Owning module (delegates) |
| --- | --- | --- |
| `CONFIG` | discovery/loading/evaluation/shape/coverage of prisma-composer.config.ts | load-config.ts (validate-coverage.ts) |
| `COMPOSE` | topology loading: entry, root node, graph shape, naming | pipeline.ts (load-entry.ts, core's graph modules) |
| `ASSEMBLE` | assembling each service's deploy artifact | `@internal/assemble`'s assemble-services.ts |
| `DEPLOY` | target selection, stage, containers, preflight, engine, teardown, stack write | operations/execute-deploy-destroy.ts (main.ts, validate-stage.ts, run-alchemy.ts) |
| `DEV` | local dev pipeline and session | operations/execute-dev.ts (core/control/local-target.ts) |
| `LOG` | log attach and tail | operations/execute-log.ts |
| `DEPS` | the consumer's installed dependency tree | check-effect-resolution.ts (operations/shared.ts) |

Closed subcode registry:

- `CONFIG` — FILE_MISSING, EXPORT_INVALID, FIELD_INVALID, EXTENSION_DUPLICATE,
  PATH_MISMATCH, EXTENSION_MISSING, DESCRIPTOR_MISSING,
  DESCRIPTOR_KIND_MISMATCH, EVALUATION_FAILED
- `COMPOSE` — ENTRY_UNLOADABLE, ENTRY_EXPORT_INVALID, ROOT_NOT_MODULE,
  NAME_MISSING, GRAPH_INVALID
- `ASSEMBLE` — EXTENSION_MISSING, DESCRIPTOR_MISSING,
  DESCRIPTOR_KIND_MISMATCH, SERVICE_MISSING, BUILD_FAILED
- `DEPLOY` — FLAG_INVALID, TARGET_CONFLICT, TARGET_MISSING, TARGET_NOT_FOUND,
  STAGE_INVALID, STAGE_UNVALIDATABLE, SCOPE_MISSING, CONTAINER_FAILED,
  PREFLIGHT_FAILED, ENGINE_FAILED, TEARDOWN_FAILED, CONTAINER_REMOVE_FAILED,
  BUILD_REQUIRED, ALCHEMY_BIN_MISSING, STACK_WRITE_FAILED
- `DEV` — PLATFORM_UNSUPPORTED, TARGET_UNSUPPORTED, CONTAINER_FAILED,
  TEARDOWN_FAILED, PREFLIGHT_FAILED, EMULATOR_FAILED, SERVICE_START_FAILED,
  CONVERGE_FAILED, ATTACH_FAILED, STACK_WRITE_FAILED
- `LOG` — PLATFORM_UNSUPPORTED, ATTACH_FAILED, ADDRESS_UNKNOWN
- `DEPS` — EFFECT_VERSION_CONFLICT, EXECUTOR_UNLOADABLE

Adding a subcode is an edit to this list; adding a namespace is an amendment to
this ADR.

## Exit codes and the human layout

The exit-code rule is the shared one (prisma/prisma's CLI Style Guide): `0` OK,
`1` internal error/bug ONLY, `2` expected failure (usage errors and structured
failures alike), `3` user abort, `130`/`143` signals.

**Documented exception:** when the spawned deploy engine (alchemy) exits
nonzero, the CLI prints the two reproduce-hint lines and passes the child's own
exit status through unchanged — the child's status is the operator's signal and
renumbering it would erase information.

The human rendering of an envelope (`render-error.ts`) is the shared layout:

```
✖ <summary> (<CODE>)
  Why: <why>
  Fix: <fix>
  Where: <path>[:<line>]
```

## Reasoning

The `code` is the machine-branching surface: hosts driving
`@prisma/composer/control`, agents, and CI branch on `failure.code` instead of
parsing message strings. Structuring at origin keeps every raise site honest —
the site that knows the context supplies the why/fix — and deleting the
fallback codes makes an unnamed failure loud (a bug, exit 1) instead of
laundering it through a vague catch-all. Structural recognition is what lets
the duplicated foundation copies interoperate until the shared package is
extracted.

## Consequences

- The former `OperationFailure` union and its `kind` taxonomy are gone; the
  registry above is the taxonomy, and a coarse "which stage" view is derivable
  from the namespace prefix.
- An engine failure carries `meta.diagnostics` (exit code, generated
  stack-file path, reproduce command, cwd), read via the
  `executionDiagnostics()` helper — mechanism details outside the durable
  contract.
- Composer's exit codes split bug (1) from expected failure (2); "everything
  nonzero" consumers are unaffected, consumers branching on `1` must move to
  the code on stderr's envelope line.

## Alternatives considered

- **A separate `domain` field alongside the code** — rejected (as in
  prisma/prisma's ADR 239): one field fewer, and the namespace carries the
  same information.
- **Renumbering the alchemy child-status passthrough onto the 2=failure rule**
  — rejected: the child's own exit status is information the operator and CI
  already use; collapsing it to 2 erases it.
- **Per-command fallback codes (`*.PIPELINE_FAILED`)** — rejected by
  base-type rule 6: fallback codes launder unnamed failures; a failure worth
  surfacing gets its own code at its origin.
- **`instanceof` recognition** — rejected: it breaks across duplicated
  copies, plane splits, and JSON boundaries.

## Related

- The shared base-types design in the prisma/prisma consolidate-clis decision
  record (rules 1–7); prisma/prisma's ADR 239 is the code-structure parent.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) —
  the programmatic surface these failures cross.
- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) —
  the spawned child behind the exit-status exception.
