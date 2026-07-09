# Deploy CLI MVP — Deferred items

- **Destroy without a build.** Investigate whether `alchemy destroy` can run
  the generated stack with placeholder bundles (does destroy-time evaluation
  invoke the pack's `package()`?). Needs live credentials. Origin: S3 review
  finding #1; MVP documents the build-first requirement instead.
- **Assemble-time native-addon detection.** The catch-all wrapper inlining
  ships a `.node`-bearing dep's JS without its binary → boot failure. Detect
  and fail loudly at assemble, or keep known-native packages external and copy
  their binaries. Origin: S3 review finding #3.
- **"Built output missing" error not covered by CLI-package tests.** The
  message lives in the assemblers (tested there); the CLI suite stubs
  assembly. A thin integration test would close it. Origin: S3 review.
- **CLI publishability.** Adapter/target packs are devDependencies of
  `makerkit-cli`; dynamic imports resolve via workspace hoisting. Fine while
  `private: true`; a published CLI needs a resolution story (peer deps or
  import-from-cwd). Origin: S3 review finding #8.
