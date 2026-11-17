// Contract 2's shapes, opaque ones by reference: on a failure update the copy, and bump CONVERGE_CONTRACT if the other side cannot read the new shape.
import { expectTypeOf, test } from 'bun:test';
import type { CallerCredentials, ContainerInstance } from '@internal/core/config';
import type {
  AlchemyStateLayer,
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

interface AppConfigurationReadAt2 {
  readonly rootInput: readonly { readonly path: readonly string[]; readonly value?: unknown }[];
}

interface BundleAt2 {
  readonly dir: string;
  readonly entry: string;
  readonly watch?: readonly string[];
}

type PlatformVariableReaderAt2 =
  | { readonly kind: 'field'; readonly service: string; readonly path: string }
  | { readonly kind: 'unread'; readonly node: string };

interface PreflightFindingsAt2 {
  readonly unset: readonly {
    readonly name: string;
    readonly readers: readonly PlatformVariableReaderAt2[];
    readonly commands: readonly string[];
  }[];
}

interface DeployedNodeAt2 {
  readonly address: string;
  readonly node: DeployedNode['node'];
  readonly entities: readonly {
    readonly kind: string;
    readonly id: string;
    readonly url?: string;
    readonly details?: Readonly<Record<string, string>>;
  }[];
}

interface DeploymentResultAt2 {
  readonly app: string;
  readonly nodes: readonly DeployedNodeAt2[];
  readonly findings: PreflightFindingsAt2;
}

interface LowerOptionsAt2 {
  readonly name: string;
  readonly environment?: string;
  readonly appConfigurationRead?: AppConfigurationReadAt2;
  readonly firstProcessNodeAddresses?: readonly string[];
  readonly bundles: Record<string, BundleAt2>;
  readonly state?: AlchemyStateLayer;
  readonly providers?: Layer.Layer<never>;
  readonly report?: (result: DeploymentResultAt2) => void;
  readonly unassembled?: readonly string[];
  readonly containers?: ReadonlyMap<string, ContainerInstance> | undefined;
  readonly preflightPayloads?: ReadonlyMap<string, string> | undefined;
  readonly findings?: PreflightFindingsAt2;
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
