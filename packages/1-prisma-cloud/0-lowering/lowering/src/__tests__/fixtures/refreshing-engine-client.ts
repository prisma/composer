import { createManagementApiClient } from '@prisma/management-api-sdk';

/**
 * An SDK client over a fetch that behaves like the engine's: it sets
 * `Authorization` last, clones the request before sending it, and on a 401
 * sends the clone again with a refreshed token.
 */
export function refreshingEngineClient(origin: string) {
  const received: { authorization: string | null; body: string }[] = [];
  let token = 'expired';
  const client = createManagementApiClient({
    baseUrl: origin,
    fetch: async (request: Request) => {
      const send = async (attempt: Request) => {
        attempt.headers.set('Authorization', `Bearer ${token}`);
        received.push({
          authorization: attempt.headers.get('authorization'),
          body: await attempt.text(),
        });
        return new Response('{}', { status: token === 'expired' ? 401 : 200 });
      };
      const retry = request.clone();
      const first = await send(request);
      if (first.status !== 401) return first;
      token = 'refreshed';
      return send(retry);
    },
  });
  return { client, received };
}
