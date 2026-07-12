import { defineConfig } from '@prisma/compose-tsdown';

export default defineConfig({
  entry: ['src/bin.ts'],
  // Bin-only launcher; nothing is importable from it.
  exports: false,
  // The launcher is a thin shim: keep @prisma/compose-cli external so it resolves the
  // real installed package at runtime rather than inlining a stale snapshot.
  external: ['@prisma/compose-cli'],
});
