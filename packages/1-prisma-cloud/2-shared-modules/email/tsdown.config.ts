import { baseConfig } from '@internal/tsdown-config';
import { defineConfig } from 'tsdown';

// Mirrors storage's multi-pass shape (storage/tsdown.config.ts): index +
// email-service in one pass at the dist root (emailService resolves
// `./email-service.mjs` from the code that calls it, via import.meta.url),
// email-entrypoint fully inlined and standing alone, and testing (the local
// stand-in) in its own pass. `bun` stays external everywhere it's reached
// (a runtime builtin, ADR-0008); `@internal/`/`@prisma/`/`arktype`/
// `@standard-schema/`/`nodemailer` are inlined so the entrypoint/testing
// bundles are otherwise self-contained. Kept as separate passes with a
// hand-maintained `package.json#exports` per the exports-entrypoints rule's
// multi-pass exception.
export default defineConfig([
  {
    ...baseConfig,
    entry: { index: 'src/exports/index.ts', 'email-service': 'src/exports/email-service.ts' },
    exports: false,
    clean: true,
  },
  {
    ...baseConfig,
    entry: { 'email-entrypoint': 'src/exports/email-entrypoint.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//, /^arktype/, /^@standard-schema\//, /^nodemailer/],
  },
  {
    // The /testing local stand-in (startLocalEmailServer). Its own pass with
    // `bun` external so the engine's Bun.serve resolves at runtime; kept off
    // the index pass so index.mjs never shares a chunk carrying a runtime
    // token.
    ...baseConfig,
    entry: { testing: 'src/exports/testing.ts' },
    exports: false,
    clean: false,
    skipNodeModulesBundle: false,
    external: [/^bun$/, /^bun:/],
    noExternal: [/^@internal\//, /^@prisma\//],
  },
]);
