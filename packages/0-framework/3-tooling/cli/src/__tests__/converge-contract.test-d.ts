/**
 * The shapes converge contract 2 covers, as they were when it was set. A change
 * to any of them fails here. If the other side can still read the new shape,
 * update the copy below; if it cannot, also bump `CONVERGE_CONTRACT`.
 */
import { expectTypeOf, test } from 'bun:test';
import type { AppConfigurationRead } from '@internal/core';
import type {
  CallerCredentials,
  ContainerInstance,
  PreflightFindings,
} from '@internal/core/config';
import type {
  AlchemyStateLayer,
  Bundle,
  DeployedNode,
  DeploymentResult,
  LowerOptions,
} from '@internal/core/deploy';
import type * as Layer from 'effect/Layer';
import type { CONVERGE_CONTRACT } from '../converge-contract.ts';
import type {
  ConvergeEvent,
  ConvergeFailureReason,
  ConvergeOutcome,
  ConvergeRequest,
  LoweredStack,
  ResourcePhase,
} from '../converge-in-process.ts';

interface LowerOptionsAt2 {
  readonly name: string;
  readonly environment?: string;
  readonly appConfigurationRead?: AppConfigurationRead;
  readonly firstProcessNodeAddresses?: readonly string[];
  readonly bundles: Record<string, Bundle>;
  readonly state?: AlchemyStateLayer;
  readonly providers?: Layer.Layer<never>;
  readonly report?: (result: DeploymentResult) => void;
  readonly unassembled?: readonly string[];
  readonly containers?: ReadonlyMap<string, ContainerInstance> | undefined;
  readonly preflightPayloads?: ReadonlyMap<string, string> | undefined;
  readonly findings?: PreflightFindings;
  readonly credentials?: CallerCredentials | undefined;
}

interface ConvergeRequestAt2 {
  readonly operation: 'deploy';
  readonly stack: LoweredStack;
  readonly stage: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: ConvergeEvent) => void) | undefined;
  readonly output?: ((text: string) => void) | undefined;
}

type ConvergeOutcomeAt2 =
  | { readonly kind: 'applied' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'failed'; readonly reasons: readonly ConvergeFailureReason[] }
  | { readonly kind: 'refused'; readonly reason: 'already-running' | 'worker-thread' };

type ConvergeEventAt2 =
  | {
      readonly kind: 'resource';
      readonly fqn: string;
      readonly resourceType: string;
      readonly status: string;
      readonly phase: ResourcePhase;
      readonly message?: string | undefined;
    }
  | {
      readonly kind: 'log';
      readonly severity: 'info' | 'warn' | 'verbose';
      readonly text: string;
    };

interface DeploymentResultAt2 {
  readonly app: string;
  readonly nodes: readonly DeployedNode[];
  readonly findings: PreflightFindings;
}

test('converge contract 2 covers these shapes, unchanged', () => {
  expectTypeOf<typeof CONVERGE_CONTRACT>().toEqualTypeOf<2>();
  expectTypeOf<LowerOptions>().toEqualTypeOf<LowerOptionsAt2>();
  expectTypeOf<ConvergeRequest>().toEqualTypeOf<ConvergeRequestAt2>();
  expectTypeOf<ConvergeOutcome>().toEqualTypeOf<ConvergeOutcomeAt2>();
  expectTypeOf<ConvergeEvent>().toEqualTypeOf<ConvergeEventAt2>();
  expectTypeOf<DeploymentResult>().toEqualTypeOf<DeploymentResultAt2>();
  expectTypeOf<ConvergeFailureReason>().toEqualTypeOf<{
    readonly tag: string;
    readonly message: string;
  }>();
  expectTypeOf<ResourcePhase>().toEqualTypeOf<'pending' | 'running' | 'done' | 'failed'>();
});
