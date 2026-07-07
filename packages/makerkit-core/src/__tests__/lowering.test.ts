import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import type { LoweredNode } from '../deploy.ts';
import { LowerError, type LowerOptions, lowering, type Target } from '../deploy.ts';
import { resource, service } from '../node.ts';
import { conn, memoryAdapter } from './helpers.ts';

const opts: LowerOptions = {
  name: 'hello',
  artifact: { path: '/tmp/hello.tar.gz', sha256: 'abc123' },
};

const adapter = memoryAdapter({});
const db = () => resource({ type: 'fake/db', connection: conn({}, () => ({})) });
const app = (
  type: string,
  inputs: Record<string, ReturnType<typeof db>>,
  handler = () => null as unknown,
) => service({ type, inputs, params: {}, config: adapter, handler });

// The fake lowerings are pure, so the composable form runs synchronously.
const run = (eff: ReturnType<typeof lowering>): LoweredNode =>
  Effect.runSync(eff as Effect.Effect<LoweredNode, LowerError>);

const runError = (eff: ReturnType<typeof lowering>): LowerError =>
  Effect.runSync(Effect.flip(eff as Effect.Effect<LoweredNode, LowerError>));

function recordingTarget() {
  const calls: { id: string; type: string; loweredSoFar: string[] }[] = [];
  const target: Target = {
    name: 'fake',
    providers: () => {
      throw new Error('providers() must not be called by lowering()');
    },
    lower: {
      'fake/db': (ctx) => {
        calls.push({ id: ctx.id, type: ctx.node.type, loweredSoFar: [...ctx.lowered.keys()] });
        return Effect.succeed({ outputs: { url: `db://${ctx.id}` } });
      },
      'fake/app': (ctx) => {
        calls.push({ id: ctx.id, type: ctx.node.type, loweredSoFar: [...ctx.lowered.keys()] });
        return Effect.succeed({ outputs: { url: `app://${ctx.id}` } });
      },
    },
  };
  return { target, calls };
}

describe('lowering', () => {
  test("routes each node through the target's table, deps before dependents", () => {
    const { target, calls } = recordingTarget();
    const root = app('fake/app', { db: db() });

    const result = run(lowering(root, target, opts));

    expect(calls.map((c) => c.id)).toEqual(['hello.db', 'hello']);
    expect(calls[1]!.loweredSoFar).toEqual(['hello.db']);
    expect(result).toEqual({ outputs: { url: 'app://hello' } });
  });

  test('uses opts.name as the root node id', () => {
    const { target, calls } = recordingTarget();

    run(lowering(app('fake/app', { db: db() }), target, { ...opts, name: 'acme' }));

    expect(calls.map((c) => c.id)).toEqual(['acme.db', 'acme']);
  });

  test('passes graph and opts through the LowerContext', () => {
    let seen: { graphRootId?: string; artifactPath?: string } = {};
    const target: Target = {
      name: 'fake',
      providers: () => {
        throw new Error('unused');
      },
      lower: {
        'fake/app': (ctx) => {
          seen = { graphRootId: ctx.graph.root.id, artifactPath: ctx.opts.artifact.path };
          return Effect.succeed({ outputs: {} });
        },
      },
    };

    run(lowering(app('fake/app', {}), target, opts));

    expect(seen).toEqual({ graphRootId: 'hello', artifactPath: '/tmp/hello.tar.gz' });
  });

  test('fails with LowerError naming the type and the known types on an unknown node type', () => {
    const { target } = recordingTarget();
    const root = app('fake/unknown-kind', { db: db() });

    const error = runError(lowering(root, target, opts));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('fake/unknown-kind');
    expect(error.message).toContain('fake/db');
    expect(error.message).toContain('fake/app');
  });

  test('runs no handler', () => {
    let calls = 0;
    const { target } = recordingTarget();
    const root = app('fake/app', { db: db() }, () => {
      calls += 1;
      return null;
    });

    run(lowering(root, target, opts));

    expect(calls).toBe(0);
  });
});
