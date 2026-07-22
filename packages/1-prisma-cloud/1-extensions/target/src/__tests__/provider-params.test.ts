import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { buildProviderParams, PROVIDER_PARAMS, prismaCloud } from '../exports/control.ts';
import { RESERVED_PROVIDER_PARAMS } from '../provider-params.ts';
import type { ProviderParamEntry } from '../serializer.ts';

const FAKE_BRAND_A: unique symbol = Symbol('provider-params.test.ts/fake-brand-a');
const FAKE_BRAND_B: unique symbol = Symbol('provider-params.test.ts/fake-brand-b');

describe('control.ts derives PROVIDER_PARAMS from provider-params.ts, not the other way around', () => {
  test("buildProviderParams throws when a boot-side entry's brand has no registered deploy-side value() — the drift Finding B closes", () => {
    const entries: readonly ProviderParamEntry[] = [
      { name: 'FAKE_A', schema: type('string'), brand: FAKE_BRAND_A },
      { name: 'FAKE_B', schema: type('string'), brand: FAKE_BRAND_B },
    ];
    // Only FAKE_BRAND_A has a registered value() — the shape deploy would be
    // in if a brand were added to RESERVED_PROVIDER_PARAMS (the boot-side
    // list) without a matching registration in control.ts.
    const values = new Map([[FAKE_BRAND_A, { value: () => 'a-value' }]]);

    expect(() => buildProviderParams(entries, values)).toThrow(/FAKE_B/);
    expect(() => buildProviderParams(entries, values)).toThrow(
      /has no registered deploy-side value/,
    );
  });

  test('buildProviderParams succeeds and carries every entry through when every brand has a registered value()', () => {
    const entries: readonly ProviderParamEntry[] = [
      { name: 'FAKE_A', schema: type('string'), brand: FAKE_BRAND_A },
      { name: 'FAKE_B', schema: type('string'), brand: FAKE_BRAND_B },
    ];
    const values = new Map([
      [FAKE_BRAND_A, { value: () => 'a-value' }],
      [FAKE_BRAND_B, { valueForService: () => 'b-value' }],
    ]);

    const built = buildProviderParams(entries, values);
    expect([...built.keys()]).toEqual([FAKE_BRAND_A, FAKE_BRAND_B]);
    const a = built.get(FAKE_BRAND_A);
    const b = built.get(FAKE_BRAND_B);
    expect(a?.name).toBe('FAKE_A');
    // Each registration kind carries through as its own kind: A stays
    // edge-derived, B stays service-derived.
    expect(a !== undefined && 'value' in a ? a.value([]) : undefined).toBe('a-value');
    expect(
      b !== undefined && 'valueForService' in b
        ? b.valueForService({ endpointDomain: undefined as never }, 'addr')
        : undefined,
    ).toBe('b-value');
  });

  test('the real registry: every param control.ts writes for deploy is exactly a param provider-params.ts lists for boot', () => {
    // Now a structural guarantee (PROVIDER_PARAMS is built BY mapping over
    // RESERVED_PROVIDER_PARAMS), not a coincidence two independent lists
    // happen to agree — this test exists as a sensor should that construction
    // ever get bypassed (e.g. a future edit that hand-writes an extra entry
    // into PROVIDER_PARAMS alongside the derived ones).
    const deploySide = [...PROVIDER_PARAMS.values()].map((entry) => entry.name).sort();
    const bootSide = RESERVED_PROVIDER_PARAMS.map((entry) => entry.name).sort();
    expect(deploySide).toEqual(bootSide);
  });
});

describe("control.ts's PROVISIONERS and PROVIDER_PARAMS cover the same brands", () => {
  // Nothing else compared these two maps before this test. A brand present in
  // PROVISIONERS (core mints a value for it) but absent from PROVIDER_PARAMS
  // (no provider ever stores the accepted-keys/API-key row) mints keys for
  // consumers while the row the runtime reader checks (serve()'s accepted
  // keys, the streams entrypoint's API_KEY) never gets written — an ABSENT
  // var reads as "never provisioned", so serve() would pass through and
  // accept every caller. This test is where a future brand that legitimately
  // needs no provider-side param would record that decision (e.g. by scoping
  // the assertion to an explicit allowlist) — it is not a law, just currently
  // true for every brand this target registers.
  test('every brand in provisions (the minting registry) has a matching reserved provider param, and vice versa', () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const provisionerBrands = [...(target.provisions?.keys() ?? [])];
    // A service-derived param (valueForService) mints nothing — its value
    // comes from the service's own provisioned attributes, not from a
    // per-edge provisioner — so only edge-derived params are compared here.
    const paramBrands = [...PROVIDER_PARAMS.entries()]
      .filter(([, entry]) => !('valueForService' in entry))
      .map(([brand]) => brand);

    expect(new Set(provisionerBrands)).toEqual(new Set(paramBrands));
    expect(provisionerBrands.length).toBeGreaterThan(0);
  });
});
