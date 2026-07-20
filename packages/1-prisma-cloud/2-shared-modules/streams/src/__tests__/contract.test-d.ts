import type { Contract, DependencyEnd } from '@internal/core';
import { describe, expectTypeOf, test } from 'vitest';
import type { StreamHandle, StreamsClient } from '../client.ts';
import type { StreamDefs, StreamsConfig } from '../contract.ts';
import { durableStreams, streamDef, streamsContract } from '../contract.ts';

describe('durableStreams(contract)', () => {
  test('hydrates to one handle per declared stream name', () => {
    const jobLog = streamsContract({ jobs: streamDef(), audit: streamDef() });
    expectTypeOf(durableStreams(jobLog)).toEqualTypeOf<
      DependencyEnd<
        { readonly jobs: StreamHandle; readonly audit: StreamHandle },
        Contract<'streams', StreamDefs>
      >
    >();
  });
});

describe('durableStreams() (bare)', () => {
  test('is a DependencyEnd hydrating to a StreamsClient for dynamic stream names', () => {
    expectTypeOf(durableStreams()).toEqualTypeOf<
      DependencyEnd<StreamsClient, Contract<'streams', StreamDefs>>
    >();
  });

  test('the wire binding carries the endpoint url and the minted bearer key', () => {
    expectTypeOf<StreamsConfig>().toEqualTypeOf<{
      readonly url: string;
      readonly apiKey: string;
    }>();
  });
});
