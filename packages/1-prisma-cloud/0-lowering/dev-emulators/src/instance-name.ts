/**
 * `pcdev-<app>-<database-id>` instance-name derivation (local-dev spec § 2
 * `postgres-main.ts`): each half lowercased, every char outside `[a-z0-9]`
 * replaced by `-`, runs collapsed, the combined name trimmed to 63 chars.
 *
 * A separate, side-effect-free module (not defined inline in
 * `postgres-main.ts`) so it can be imported directly by tests without also
 * running that file's own `main()` — `postgres-main.ts` is a daemon
 * entrypoint script, always invoked as a subprocess, and calls `main()`
 * unconditionally at module load.
 */

/**
 * Deliberately linear, no ambiguous quantifiers: a per-character replace
 * (no `+`, so no run-length backtracking surface), a bounded-quantifier
 * collapse (`{2,}`, not alternation-with-quantifiers), and plain
 * index-walking for the leading/trailing trim instead of a regex — a
 * combined `+`-plus-alternation trim (`/^-+|-+$/g`) is exactly the shape
 * CodeQL's polynomial-ReDoS check flags, whether or not this particular
 * instance is provably safe.
 */
export function slug(segment: string): string {
  const collapsed = segment
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-{2,}/g, '-');
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '-') start++;
  while (end > start && collapsed[end - 1] === '-') end--;
  return collapsed.slice(start, end);
}

export function instanceNameFor(app: string, id: string): string {
  return `pcdev-${slug(app)}-${slug(id)}`.slice(0, 63);
}
