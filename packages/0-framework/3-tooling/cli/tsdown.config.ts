import { defineConfig } from '@internal/tsdown-config';

// `render-deployment.ts` is its own entry (published as `./report`), not part
// of the `.` barrel: the generated stack file imports the renderer into the
// ALCHEMY CHILD, and the barrel would drag the whole CLI (the engine and
// every configured extension's control-plane code) in with it. The renderer
// imports nothing but core's types, so its own entry stays that way.
export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    report: 'src/exports/render-deployment.ts',
    control: 'src/exports/control.ts',
    family: 'src/exports/family.ts',
    testing: 'src/exports/testing.ts',
  },
});
