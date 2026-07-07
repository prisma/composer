const format = (files) => {
  const quoted = files.map((f) => `"${f}"`).join(' ');
  return [
    `biome format --write --no-errors-on-unmatched ${quoted}`,
    `biome check --write --no-errors-on-unmatched ${quoted}`,
  ];
};

export default {
  '*.{ts,tsx,js,jsx,mjs,json,jsonc,css}': format,
};
