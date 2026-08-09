# ADR-0044: Errors are structural envelopes with dotted namespace codes

## The shape of a failure, end to end

The site that detects a failure builds the complete error, because it is the only place that knows the context:

```ts
// @internal/assemble — a raise site
if (!descriptor) {
  throw new AssembleError('ASSEMBLE.DESCRIPTOR_MISSING', `No deploy descriptor for "${address}"`, {
    why: `Extension "${extensionName}" declares no descriptor for this service kind.`,
    fix: 'Add a deploy descriptor to the extension, or remove the service from the graph.',
    meta: { address },
  });
}
```

Every in-process consumer — the CLI's own adapters, a host driving `@prisma/composer/control` — branches on exactly two fields, for every operation (a `Result` never crosses a process boundary; CI and other out-of-process consumers see the rendered envelope on stderr and the exit code instead):

```ts
const result = await deploy(options);
if (!result.ok) {
  switch (result.failure.code) {
    case 'ASSEMBLE.DESCRIPTOR_MISSING': /* actionable: fix the extension */
    case 'DEPS.EFFECT_VERSION_CONFLICT': /* actionable: fix the install */
    default: /* render the envelope; exit 2 */
  }
}
```

A structured error is never transformed between the two snippets: the value raised at the origin is the value the consumer holds, whether it arrived by throw or as a `Result` failure. A *foreign* error (a rejecting build, a throwing extension hook) is wrapped exactly once — at the site that understands it, into a structured error carrying the original as `cause` — and from there the same no-transformation rule applies.

## Decision

Composer uses the shared CLI error foundation (prisma/prisma's ADR 239 / ADR 245 lineage), carried in `@internal/foundation`:

- Every user-surfaced failure is a **`CliStructuredError`**: `code` is a dotted
  `NAMESPACE.SUBCODE` string, `message` is the summary, and the optional
  `why`/`fix`/`where`/`meta`/`docsUrl` fields complete the envelope
  (`toEnvelope()` serializes it). The namespace prefix IS the error's category —
  there is no separate `domain` field.
- **Errors are structured at their origin — there are no catch-all codes.** A
  library type meant to surface (core's `LoadError`, assemble's
  `AssembleError`, a config-evaluation failure, an I/O failure the tool can
  name) is a structured error where it is raised. Site-specific wraps of
  foreign causes (an extension hook, the environment) are legal and attach the
  original as `cause`; boundary fallbacks like "pipeline failed" are banned.
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
  DESCRIPTOR_KIND_MISMATCH, EVALUATION_FAILED, INVALID (several config
  diagnostics combined into one failure; each rides in `meta.issues` as
  `{ kind, message }` — prisma/prisma's shared envelope idiom. A single
  diagnostic surfaces as itself, never wrapped)
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

The exit-code rule is the shared one (prisma/prisma's CLI Style Guide), and it
governs statuses the CLI itself generates: `0` OK, `1` internal error/bug ONLY,
`2` expected failure (usage errors and structured failures alike), `3` user
abort, `130`/`143` signals.

**Documented exception:** when the spawned deploy engine (alchemy) exits
nonzero, the CLI prints the two reproduce-hint lines and passes the child's own
exit status through unchanged — the child's status is the operator's signal and
renumbering it would erase information. A passthrough status is the child's
number, not a statement in the CLI's own code space: an expected engine failure
may therefore surface as `1` (or any other value) without contradicting the
rule above.

The human rendering of an envelope (`render-error.ts`) is the shared layout:

```text
✖ <summary> (<CODE>)
  Why: <why>
  Fix: <fix>
  Where: <path>[:<line>]
```

## Reasoning

The `code` is the machine-branching surface: hosts driving
`@prisma/composer/control`, agents, and CI branch on `failure.code` instead of
parsing message strings. Structuring at origin keeps every raise site honest —
the site that knows the context supplies the why/fix — and banning fallback
codes makes an unnamed failure loud (a bug, exit 1) instead of laundering it
through a vague catch-all. Structural recognition is what lets composer's copy
of the foundation interoperate with any other copy of it.

## Consequences

- The registry above is the failure taxonomy. A coarse "which stage failed"
  view is derivable from the namespace prefix; no separate stage discriminant
  is stored on failures.
- An engine failure carries `meta.diagnostics` (exit code, generated
  stack-file path, reproduce command, cwd), read via the
  `executionDiagnostics()` helper — mechanism details outside the durable
  contract.
- Exit codes distinguish a bug (1) from an expected failure (2); "any nonzero
  means failure" consumers are unaffected either way.

## Alternatives considered

- **A separate `domain` field alongside the code** — rejected (as in
  prisma/prisma's ADR 239): one field fewer, and the namespace carries the
  same information.
- **Renumbering the alchemy child-status passthrough onto the 2=failure rule**
  — rejected: the child's own exit status is information the operator and CI
  already use; collapsing it to 2 erases it.
- **Per-command fallback codes (`*.PIPELINE_FAILED`)** — rejected: fallback
  codes launder unnamed failures; a failure worth surfacing gets its own code
  at its origin.
- **A stored per-operation `kind` discriminant on failures** — rejected: a
  second vocabulary restating what the namespace prefix and the `ok`
  discriminator already say.
- **`instanceof` recognition** — rejected: it breaks across duplicated
  copies, plane splits, and JSON boundaries.

## Related

- prisma/prisma's [ADR 239](https://github.com/prisma/prisma/blob/main/docs/architecture%20docs/adrs/ADR%20239%20-%20Errors%20are%20structural%20envelopes%20with%20dotted%20namespace%20codes.md)
  (the envelope and code convention) and
  [ADR 245](https://github.com/prisma/prisma/blob/main/docs/architecture%20docs/adrs/ADR%20245%20-%20Errors%20are%20structured%20at%20origin%3B%20results%20carry%20one%20ok%20discriminator.md)
  (origin structuring and the single `ok` discriminator) — the parents of the
  rules recorded here.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) —
  the programmatic surface these failures cross.
- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) —
  the spawned child behind the exit-status exception.
