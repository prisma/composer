/**
 * The wrapper-inlining decision (S2's open question — see the project's
 * design-notes.md and this slice's final report for the write-up).
 *
 * The CLI has no config file, so it can't take per-app `wrapperNoExternal`
 * patterns — it needs one general rule for what an assembler inlines into
 * the wrapper build besides `@makerkit/*` (already the assemblers' own
 * default).
 *
 * The rule: inline everything except the runtime's own modules — `bun`,
 * `bun:*` (e.g. bun:sqlite), and `node:*` builtins — which resolve inside
 * the deploy VM at runtime and must never be bundled. Verified (both
 * `@makerkit/node/assemble` and `@makerkit/nextjs/assemble` set
 * `external: ['bun']` ahead of `noExternal` in their tsdown call, and tsdown/
 * rolldown's explicit `external` wins over a `noExternal` match — proven by
 * building an app's wrapper with this exact pattern: the
 * `bun` import stays external while everything else, including the app's own
 * workspace deps, gets inlined) — see this slice's final report for the
 * storefront-auth wrapper proof (arktype + `@storefront-auth/auth/contract`
 * inlined with no other file changes there).
 */
export const INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS: readonly RegExp[] = [
  /^(?!bun$)(?!bun:)(?!node:).+/,
];
