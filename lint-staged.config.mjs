const format = (files) => {
  const quoted = files.map((f) => `"${f}"`).join(' ');
  return [
    `biome format --write --no-errors-on-unmatched ${quoted}`,
    `biome check --write --no-errors-on-unmatched ${quoted}`,
  ];
};

export default {
  '*.{ts,tsx,js,jsx,mjs,json,jsonc,css}': format,
  // Architecture boundaries (ADR-0028): any source or config change re-checks
  // the domain/layer/plane rules. Run once, not per-file.
  '{packages,examples,test}/**/*.{ts,tsx}': () => 'pnpm lint:deps',
  'architecture.config.json': () => 'pnpm lint:deps',
  'dependency-cruiser.config.mjs': () => 'pnpm lint:deps',
  // Dropping a `paths` entry makes the cruiser resolve that import to built
  // dist, which is excluded — the edge vanishes and no rule fires on it.
  'tsconfig.depcruise.json': () => 'pnpm lint:deps',
};
