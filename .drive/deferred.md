# Deploy CLI MVP — Deferred items

- **Destroy without a build.** Investigate whether `alchemy destroy` can run
  the generated stack with placeholder bundles (does destroy-time evaluation
  invoke the pack's `package()`?). Needs live credentials. Origin: S3 review
  finding #1; MVP documents the build-first requirement instead.
- **Assemble-time native-addon detection.** The catch-all wrapper inlining
  ships a `.node`-bearing dep's JS without its binary → boot failure. Detect
  and fail loudly at assemble, or keep known-native packages external and copy
  their binaries. Origin: S3 review finding #3.
- **"Built output missing" error not covered by CLI-package tests — closed by
  S5.** `test/integration/test/cli.entry-anchored-resolution.test.ts` now
  drives the real CLI binary against a real, unbuilt fixture app and asserts
  on the real "no built entry at" message from `@makerkit/node`'s assembler.
  Origin: S3 review.
- **CLI publishability — closed by S5.** The CLI no longer depends on any
  target/adapter pack; resolution is anchored at the app's entry package via
  `createRequire` (see `packages/makerkit-cli/src/resolve-from-entry.ts`).
  Origin: S3 review finding #8.
