import { baseConfig, defineConfig } from '@internal/tsdown-config';

// `bin.ts` is the executable target, not an importable module, so it stays at
// the `src/` root. The base `exclude: [/^bin$/]` keeps `bin` out of the
// generated exports map; `bin: false` additionally stops tsdown from
// auto-declaring a top-level `bin` field off bin.ts's shebang — this package is
// private and ships no executable (@prisma/composer publishes the CLI).
//
// `render-deployment.ts` is its own entry (published as `./report`), not part
// of the `.` barrel: the generated stack file imports the renderer into the
// ALCHEMY CHILD, and the barrel would drag the whole CLI (clipanion, c12, and
// every configured extension's control-plane code) in with it. The renderer
// imports nothing but core's types, so its own entry stays that way.
export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    bin: 'src/bin.ts',
    'register-entry-resolution': 'src/register-entry-resolution.ts',
    report: 'src/exports/render-deployment.ts',
    control: 'src/exports/control.ts',
    family: 'src/exports/family.ts',
    testing: 'src/exports/testing.ts',
  },
  exports:
    typeof baseConfig.exports === 'object'
      ? {
          ...baseConfig.exports,
          bin: false,
          // Exclude `register-entry-resolution` from the generated exports map
          // for the same reason `bin` is excluded: it is a preload script, not
          // an importable module path consumers call by name.
          exclude: [
            ...(Array.isArray(baseConfig.exports.exclude) ? baseConfig.exports.exclude : []),
            /^register-entry-resolution$/,
          ],
        }
      : baseConfig.exports,
});
