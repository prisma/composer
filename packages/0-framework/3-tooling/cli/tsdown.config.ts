import { defineConfig } from '@internal/tsdown-config';

// `render-deployment.ts` is its own entry (published as `./report`): the
// generated stack file imports the renderer into the ALCHEMY CHILD, so it must
// keep the renderer separate from the command family. The guarded runner also
// executes in this child and uses Alchemy's plan/apply APIs.
export default defineConfig({
  entry: {
    report: 'src/exports/render-deployment.ts',
    control: 'src/exports/control.ts',
    family: 'src/exports/family.ts',
    testing: 'src/exports/testing.ts',
  },
});
