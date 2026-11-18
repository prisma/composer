import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withComposerAdvice } from '../deployment-summary.ts';

/** The `+`-joined string literals around each non-comment source line that mentions `marker`, as the message they build. */
function adoptMessagesIn(source: string, marker = '--adopt'): string[] {
  const lines = source.split('\n');
  const joinedWithNext = (index: number) => /\+\s*$/.test(lines[index] ?? '');
  const messages: string[] = [];
  lines.forEach((line, index) => {
    if (!line.includes(marker) || /^\s*(\*|\/\/)/.test(line)) return;
    let start = index;
    while (start > 0 && joinedWithNext(start - 1)) start--;
    let end = index;
    while (joinedWithNext(end)) end++;
    const literals =
      lines
        .slice(start, end + 1)
        .join('\n')
        .match(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
    const message = literals.map((literal) => literal.slice(1, -1)).join('');
    if (message.includes(marker)) messages.push(message);
  });
  return messages;
}

describe('withComposerAdvice', () => {
  test("replaces every piece of Alchemy's --adopt advice with steps that work from Composer", () => {
    const upstream = [
      "OwnedBySomeoneElse: Cannot adopt resource 'auth.database-conn' (Prisma.Connection): it exists in the cloud but is not owned by this stack/stage/logical-id. Re-run with `--adopt` (or wrap the effect in `adopt(true)`) to take it over.",
      "OwnedBySomeoneElse: Cannot resume creating resource 'storefront-svc' (Prisma.App): a resource with its physical identity exists in the cloud but is not owned by this stack/stage/logical-id. Re-run with `--adopt` (or wrap the effect in `adopt(true)`) to take it over.",
      'Resource exists in the cloud but is not owned by this stack — leaving it in place (re-deploy with --adopt to take ownership, then destroy).',
      "Prisma custom domain 'shop.com' already exists on App 'app_1' but is not owned by this resource. Import it with explicit adoption instead of silently taking it over.",
      "Prisma app 'shop.web' already exists on the requested branch but is not owned by this App resource. Import it with explicit adoption or choose a different display name.",
      "A Prisma database named 'shop' appeared after the adoption check. Refusing to take it over; rerun with adoption enabled if it is the intended database.",
      "Cannot replace resource 'storefront-svc' (Prisma.App): it must be deleted before its replacement is pre-created, but the replacement's identity depends on outputs that are not resolved yet, so its ownership cannot be checked first. Re-run with `--adopt` (or wrap the effect in `adopt(true)`) to replace it anyway.",
    ];
    for (const line of upstream) {
      const shown = withComposerAdvice(line);
      expect(shown).not.toContain('--adopt');
      expect(shown).not.toContain('adopt(true)');
      expect(shown).toMatch(/Remove that resource|remove it by hand/);
    }
  });

  test('leaves other output unchanged', () => {
    const output =
      '[web] fail — UnknownError: Prisma API 409 Conflict: a deployment is already in progress';
    expect(withComposerAdvice(output)).toBe(output);
  });

  test("rewrites every --adopt message in the installed Alchemy's engine", () => {
    let root = path.dirname(fileURLToPath(import.meta.resolve('alchemy')));
    while (!fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root);
    const messages = ['Plan.ts', 'Apply.ts'].flatMap((file) =>
      adoptMessagesIn(fs.readFileSync(path.join(root, 'src', file), 'utf8')),
    );
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(withComposerAdvice(message)).not.toContain('--adopt');
    }
  });

  test('rewrites every adoption message in the installed Prisma provider', () => {
    const providerSrc = path.join(
      path.dirname(fileURLToPath(import.meta.resolve('@alchemy.run/prisma/package.json'))),
      'src',
    );
    const messages = fs
      .readdirSync(providerSrc, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) =>
        adoptMessagesIn(fs.readFileSync(path.join(providerSrc, file), 'utf8'), 'adoption'),
      );
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(withComposerAdvice(message)).not.toMatch(/explicit adoption|adoption enabled/);
    }
  });
});
