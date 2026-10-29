# P1 — dispatch plan

Spec: [spec.md](spec.md). D1 first; D2 and D3 then run in parallel, because they touch different files. Every dispatch implements its spec sections exactly; an implementer who finds the spec and the code in conflict stops and reports.

## D1. `publicUrl()` and its Prisma Cloud lowering

- **Outcome:** spec §§ 3, 4, 5, 6 and 8: `public-url.ts` (types, `publicUrl`, `publicUrl.hostname`, `publicUrl.prismaBuild`, `parseHostname`, `resolvedStrategy`); the exports from the extension's `exports/index.ts` and from `@prisma/composer-prisma-cloud`; `@internal/http` moved to `dependencies`; `descriptors/public-url.ts` registered under `nodes['public-url']`; `serviceId` added to the compute descriptor's `deploy` and `reserve` outputs; `runPreflight` calling `resolvedStrategy`.
- **Tests:** AC 1 to 7 and AC 10. AC 1's type error is a `.test-d.ts`. AC 10 runs the real Alchemy apply over a fake Management API, the way the extension's existing lowering tests do, with a first apply that creates `shop.com` and a second that changes it to a hostname the fake refuses with 422; it asserts the deploy fails and the fake never received a delete for `shop.com`.
- **Builds on:** this branch at the commit that records the spec.
- **Hands to:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts` and the extension's `test` and `test:types` green.

## D2. The local stand-in and the dev warning

- **Outcome:** spec § 7: `LocalCustomDomainProvider` in `@internal/local-target`, registered in `localTargetProviders`; `PreflightInput.warn`; the `target-warning` dev event, emitted from `execute-dev.ts` and reported as a warning by `family/commands/dev.ts`; the extension's dev preflight calling `resolvedStrategy` and warning once per hostname public URL.
- **Tests:** AC 8: a local-target test that a custom domain under the local providers calls nothing and converges; a dev preflight test that two hostname public URLs give two warnings and a `prisma-build` one gives none; a CLI test that a `target-warning` event prints as a warning.
- **Builds on:** D1.
- **Hands to:** the same checks as D1, plus the local-target and CLI packages' tests.

## D3. The documents and the example

- **Outcome:** spec § 9, every item.
- **Builds on:** D1.
- **Hands to:** `pnpm --filter website test` and `pnpm check:skill-packaging` green; `examples/env-param` builds and its tests pass.

## D4. Verify (orchestrator)

The full suite; `prisma dev` of `examples/env-param` with a hostname public URL; `prisma deploy` of the example to production and to a preview with the deploy credentials, and the topology read back from the platform (AC 9); a deploy naming a hostname with no records (AC 11); `/drive-code-review` without the walkthrough; fixes; the pull request with Auto-fix on.
