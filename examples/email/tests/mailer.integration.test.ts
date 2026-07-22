/**
 * The mailer example app's integration test: drives the signup → verify
 * story against the email module's local stand-in (`startLocalEmailServer`
 * — in-memory store, mode `none`, no cloud credentials), the same chain the
 * deployed smoke proves. An HTTP request to the app's own `/signup`
 * endpoint sends the verification email; the test reads the stored body
 * back through the app's own `/emails/:id` endpoint, extracts the rendered
 * link, and follows it — proving the link a recipient would actually click
 * works, not just that a send happened. Dedup is module behavior, already
 * covered by the module's own tests, so it stays out of this example.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rpc } from '@prisma/composer/service-rpc';
import { emailOutboxContract, emailSender } from '@prisma/composer-prisma-cloud/email';
import {
  type LocalEmailServer,
  startLocalEmailServer,
} from '@prisma/composer-prisma-cloud/email/testing';
import { createEmailApp } from '../src/mailer/app.ts';
import { templates } from '../src/mailer/templates.tsx';

describe('mailer example app (against the local email stand-in)', () => {
  let server: LocalEmailServer;
  let app: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    server = await startLocalEmailServer();
    // The same wiring the app's own service.load() produces — hydrated
    // directly against the local server's URL, with no deploy graph.
    // `connection.hydrate` is typed `C | Promise<C>` (some dependency kinds
    // hydrate async); both of this app's kinds hydrate synchronously, and
    // `await` resolves either shape.
    const email = await emailSender(templates).connection.hydrate({ url: server.url });
    const outbox = await rpc(emailOutboxContract).connection.hydrate({ url: server.url });
    app = createEmailApp(email, outbox);
  });

  afterAll(async () => {
    await server?.stop();
  });

  test('signup sends a verification email whose link, followed, completes the story', async () => {
    const signupRes = await app(
      new Request('http://mailer/signup', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', name: 'Ada' }),
      }),
    );
    expect(signupRes.status).toBe(201);
    const { id: verificationId } = (await signupRes.json()) as { id: string };

    const storedRes = await app(new Request(`http://mailer/emails/${verificationId}`));
    expect(storedRes.status).toBe(200);
    const stored = (await storedRes.json()) as {
      templateId: string;
      subject: string;
      html: string;
    };
    expect(stored.templateId).toBe('verification');
    expect(stored.subject).toBe('Verify your email');

    const link = stored.html.match(/href="([^"]+)"/)?.[1];
    if (link === undefined) throw new Error('verification email body carried no link');
    expect(link).toMatch(/^http:\/\/mailer\/verify\?token=/);

    const verifyRes = await app(new Request(link));
    expect(verifyRes.status).toBe(200);
    const verified = (await verifyRes.json()) as { verified: boolean; id: string };
    expect(verified.verified).toBe(true);

    const welcomeRes = await app(new Request(`http://mailer/emails/${verified.id}`));
    expect(welcomeRes.status).toBe(200);
    const welcome = (await welcomeRes.json()) as {
      templateId: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(welcome.templateId).toBe('welcome');
    expect(welcome.subject).toBe('Welcome, Ada!');
    // welcome is a react-email component (templates.tsx) — assert on content
    // it definitely renders, not exact markup (react-email owns that shape).
    expect(welcome.html).toContain('Ada');
    expect(welcome.text).toContain('Ada');
  });

  test('GET /verify with an unknown token is 404', async () => {
    const res = await app(new Request('http://mailer/verify?token=does-not-exist'));
    expect(res.status).toBe(404);
  });

  test('repeating /verify (e.g. a link-scanner prefetch) dedups to the original welcome send', async () => {
    const signupRes = await app(
      new Request('http://mailer/signup', {
        method: 'POST',
        body: JSON.stringify({ email: 'repeat@example.com', name: 'Grace' }),
      }),
    );
    const { id: verificationId } = (await signupRes.json()) as { id: string };
    const storedRes = await app(new Request(`http://mailer/emails/${verificationId}`));
    const stored = (await storedRes.json()) as { html: string };
    const link = stored.html.match(/href="([^"]+)"/)?.[1];
    if (link === undefined) throw new Error('verification email body carried no link');

    const first = await app(new Request(link));
    const firstBody = (await first.json()) as { id: string };
    const second = await app(new Request(link));
    const secondBody = (await second.json()) as { id: string };

    expect(secondBody.id).toBe(firstBody.id);
  });

  test('GET /emails/:id for an unknown id is 404', async () => {
    const res = await app(new Request('http://mailer/emails/does-not-exist'));
    expect(res.status).toBe(404);
  });
});
