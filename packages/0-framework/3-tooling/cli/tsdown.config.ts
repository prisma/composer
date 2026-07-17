import { defineConfig } from '@internal/tsdown-config';

export default defineConfig({
  // `render-deployment.ts` is its own entry, not part of the `.` barrel: the
  // generated stack file imports the renderer into the ALCHEMY CHILD, and the
  // barrel would drag the whole CLI (clipanion, c12, and — via main.ts —
  // @internal/lowering) in with it. The renderer imports nothing but core's
  // types, so its own entry stays that way.
  entry: ['src/index.ts', 'src/bin.ts', 'src/render-deployment.ts'],
  // The CLI declares its `.` and `./report` exports and `bin` by hand; don't
  // auto-generate a `./bin` export (the executable must not be importable).
  exports: false,
});
