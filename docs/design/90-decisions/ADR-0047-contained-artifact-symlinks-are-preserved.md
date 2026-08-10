# ADR-0047: Contained artifact symlinks are preserved

## Decision

A symlink inside an explicitly declared directory build output remains a
symlink in the Prisma Compute `tar.gz` artifact. Composer never dereferences it.
The artifact writer accepts only relative targets whose lexical resolution stays
inside the artifact root; absolute and escaping targets are hard errors. A
dangling target is valid when it is lexically contained, because framework file
tracers can omit an unused package while retaining its package-manager alias.

Targets longer than ustar's 100-byte `linkname` field use a deterministic PAX
`linkpath` record. The local Compute extractor enforces the same containment
rule and recreates the link, so local and hosted artifacts have the same
filesystem semantics.

This narrowly supersedes ADR-0005's blanket symlink rejection. The prohibition
on dereferencing and pulling arbitrary files into an artifact remains intact.

## Reasoning

Current framework builds preserve the package manager's link structure in
self-contained output. Next standalone under pnpm, for example, links
`node_modules/next` into `.pnpm/.../node_modules/next`. Node and Bun resolve the
package from that canonical location, where its transitive dependencies are
adjacent. Dereferencing the link moves the package and changes module resolution
even though all file bytes are present. Requiring a hoisted installer layout
avoids the symptom by changing the user's dependency tree, not by correctly
deploying the framework output.

Prisma Compute artifacts are tar archives, whose symbolic-link entry is the
standard representation for this filesystem fact. Preserving a contained link
ships the build as produced, keeps the artifact small, and does not read any
file the author did not declare.

## Consequences

- npm, pnpm, Yarn, and Bun framework outputs keep their runtime package
  resolution semantics without a hoisted linker requirement.
- Composer does not bundle or post-process application packages and does not
  duplicate linked dependency trees.
- Relative links may point forward or be dangling, but their lexical target
  must remain inside the artifact.
- Absolute links, relative escapes, device entries, and other unsupported
  filesystem entries fail before upload and name the offending path.
- Artifact hashing stays deterministic: link path and target are archive bytes,
  and long targets have deterministic PAX metadata names.

## Alternatives considered

- **Require a hoisted `node_modules`.** Rejected: install layout is not a
  deployment API, and all supported package managers must retain native modes.
- **Dereference contained links.** Rejected: this changes pnpm/Bun resolution
  semantics and can make an apparently complete artifact fail at boot.
- **Copy linked dependencies into additional locations.** Rejected: this is an
  implicit hoist, duplicates trees, inflates uploads, and guesses at runtime
  resolution.

## Related

- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) — the user's build
  is authoritative and Composer performs deterministic assembly only.
- [Architectural principles](../01-principles/architectural-principles.md) — no
  app bundling, no guessing, and no arbitrary-file laundering.
