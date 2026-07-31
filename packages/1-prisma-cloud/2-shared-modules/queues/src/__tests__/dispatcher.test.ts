import { describe, expect, test } from 'bun:test';
import type { DispatcherClients } from '../execution/dispatcher.ts';
import { dispatchOnce } from '../execution/dispatcher.ts';

function clients(
  events: string[],
  delivery?: { readonly error?: Error; readonly accepted?: boolean },
): DispatcherClients {
  return {
    queue: {
      claim: async () => ({
        message: {
          id: 'message-1',
          queue: 'messages',
          body: { text: 'hello' },
          attempt: 1,
          enqueuedAt: '2026-07-31T12:00:00.000Z',
        },
        leaseToken: 'lease-1',
      }),
      complete: async () => {
        events.push('complete');
        return { ok: true };
      },
      release: async () => {
        events.push('release');
        return { outcome: 'retrying' };
      },
    },
    consumer: {
      deliver: async () => {
        events.push('deliver');
        if (delivery?.error !== undefined) throw delivery.error;
        return { ok: delivery?.accepted ?? true };
      },
    },
  };
}

describe('dispatcher', () => {
  test('completes a lease only after the consumer accepts the message', async () => {
    const events: string[] = [];
    expect(await dispatchOnce(clients(events), { leaseSeconds: 30 })).toBe(true);
    expect(events).toEqual(['deliver', 'complete']);
  });

  test('releases the lease when delivery fails', async () => {
    const events: string[] = [];
    await expect(
      dispatchOnce(clients(events, { error: new Error('consumer failed') }), {
        leaseSeconds: 30,
      }),
    ).rejects.toThrow('consumer failed');
    expect(events).toEqual(['deliver', 'release']);
  });

  test('releases the lease when the consumer rejects the delivery', async () => {
    const events: string[] = [];
    expect(await dispatchOnce(clients(events, { accepted: false }), { leaseSeconds: 30 })).toBe(
      true,
    );
    expect(events).toEqual(['deliver', 'release']);
  });
});
