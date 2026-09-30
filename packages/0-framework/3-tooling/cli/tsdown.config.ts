import { defineConfig } from '@internal/tsdown-config';

// `render-deployment.ts` is its own entry (published as `./report`): the
// generated stack file imports the renderer into the ALCHEMY CHILD, so it must
// import nothing but core's types.
export default defineConfig({
  entry: {
    report: 'src/exports/render-deployment.ts',
    control: 'src/exports/control.ts',
    family: 'src/exports/family.ts',
    testing: 'src/exports/testing.ts',
  },
});
