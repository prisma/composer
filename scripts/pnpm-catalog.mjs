/** The version a pnpm-workspace.yaml `catalog:` block pins for `name`, read line by line. */
export function catalogVersion(workspaceYaml, name) {
  const lines = workspaceYaml.split('\n');
  const start = lines.indexOf('catalog:');
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^[ \t]/.test(line)) return undefined;
    const [key, ...rest] = line.trim().split(':');
    if (key === name) return /^\s*['"]?([^'"\s#]+)/.exec(rest.join(':'))?.[1];
  }
  return undefined;
}
