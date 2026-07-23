/**
 * The authoring-barrel runtime-coupling invariant (spec § Package layout):
 * bundling the barrel yields NO `node:`/`bun` tokens and none of the
 * deploy-plane machinery (`effect`, `alchemy`) — a consumer graph importing
 * the auth module must stay runnable anywhere. jose is a runtime dep of the
 * barrel by design (pure ESM, no `node:` imports); this test is what holds
 * that claim over time. Pattern: the target's invariants.test.ts probe.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

describe('authoring barrel', () => {
  test('bundles with no node:/bun/effect/alchemy tokens', async () => {
    const out = await Bun.build({
      entrypoints: [path.join(import.meta.dir, 'fixtures', 'probe-authoring.ts')],
      target: 'bun',
    });
    expect(out.success).toBe(true);

    const js = await out.outputs[0]!.text();
    // Positive markers: the probe genuinely bundled the surface (the port
    // kind and the pack claim both survive minification-free bundling).
    expect(js).toContain('auth-api');
    expect(js).toContain('requiredPackHead');
    for (const token of [
      'alchemy',
      'from "effect',
      'prisma-alchemy',
      'new SQL(',
      'from "bun"',
      '"node:', // a node:-scheme import always appears quoted in a bundle
      '@prisma-next/', // the pn runtime (and pg under it) must stay opt-in
      'better-auth', // the library belongs to the service/embedded side, never the consumer barrel
    ]) {
      expect({ token, present: js.includes(token) }).toEqual({ token, present: false });
    }
  });
});
