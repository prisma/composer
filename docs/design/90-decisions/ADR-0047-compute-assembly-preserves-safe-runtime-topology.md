# ADR-0047: Compute assembly preserves safe runtime topology and proves routing

## Decision

Composer's Compute path turns declared built output into a self-contained artifact without rewriting application code:

```text
declared entry ──trace imports──▶ staged runtime files
safe symlink   ────────────────▶ archived as a symlink
escaping link  ────────────────▶ hard error
promoted URL   ──route probe───▶ deploy succeeds
```

The Node directory adapter traces the explicitly declared entry's static runtime file graph and stages those files beside the directory the author named. It does not choose an entry, run a build, or bundle the application.

The Compute archive preserves a symlink as a tar symlink only after resolving its real target and proving that target remains inside the assembled bundle. It never dereferences the link. Dangling links and links that escape the bundle are errors.

The generated bootstrap may install a narrowly scoped compatibility shim when Compute's JavaScript runtime differs from the Node behavior a framework relies on. Such a shim must be feature-gated to that runtime and must run before the application entry is imported.

Compute also supplies `HOST=0.0.0.0` when the author did not configure a host. Framework servers must listen on Compute's network interface rather than a loopback-only default; an explicit author value remains authoritative.

After promotion, lowering probes the stable application URL. Any application-owned HTTP response proves that routing reached the deployment; the platform's explicit missing-service response does not. A deployment is not reported successful while that marker remains.

## Reasoning

"Users build; Composer assembles" is a boundary between owning a build and manufacturing a deployment artifact. It does not require Composer to ignore the runtime topology recorded by a build. Astro's Node adapter, for example, emits server files that deliberately retain bare package imports. Copying only `dist/` preserves the bytes but not the runnable program. Tracing from the author-declared entry follows package metadata and import edges deterministically; it is file assembly, not a second application build.

The same distinction applies to symlinks. Dereferencing a package-manager link can silently pull arbitrary deploy-machine files into an artifact, which remains forbidden. Preserving the link itself retains the build's topology. Resolving the target only for validation proves that the archived link cannot escape the artifact, including through a chain of links, without copying the target through the link.

Frameworks also exercise details of the Compute runtime that a plain HTTP server may not. A compatibility shim belongs in Composer's generated bootstrap because it is part of the hosting envelope, not the user's framework build. The shim is deliberately narrow: the current URL custom-inspect setter restores Node-compatible assignment semantics for Bun without patching SvelteKit output or changing unrelated globals.

Finally, an API status of `running` and a successful promotion describe control-plane progress, not data-plane routing. The stable URL is the observable contract returned to the author. Probing it closes that gap while treating the application's own status code as application policy rather than deployment policy.

## Consequences

- Node directory artifacts can carry runtime packages that a framework intentionally leaves external.
- Safe package-manager and framework symlinks remain links in both cloud and local artifacts; escaping or dangling links fail before upload.
- Runtime compatibility code is isolated in the generated bootstrap and covered by framework deployment tests.
- Framework servers receive a listen-all host default without overriding an author-configured host.
- A deploy can take longer after promotion, and fails instead of returning a URL that still routes to the platform's missing-service handler.
- These mechanisms are compatibility ownership, not permanent duplication. When the upstream Alchemy Compute provider supplies an equivalent archive, build staging, runtime bootstrap, or readiness guarantee, Composer deletes the corresponding local mechanism rather than keeping two implementations.

## Alternatives considered

**Require every build directory to be flat and fully self-contained.** Rejected: standard framework outputs do not all have that shape, and forcing every application to maintain post-build copy scripts moves hosting assembly into userland.

**Dereference symlinks during packaging.** Rejected: it changes the build topology and can package files outside the declared artifact boundary.

**Bundle the application entry again.** Rejected: that crosses the user-build boundary and creates a second framework compatibility surface. Static file tracing preserves the application's emitted code.

**Treat promotion as deployment readiness.** Rejected: promotion can succeed while the stable endpoint still returns the platform's missing-service response.

## Related

- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) — users own builds; Composer owns deterministic artifact assembly.
- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) — Alchemy is the provisioning engine behind deploy.
- [Architectural principles](../01-principles/architectural-principles.md) — Composer does not bundle application code or guess build output.
