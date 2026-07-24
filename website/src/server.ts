// The docs site entry. Serves the landing page at / and each guide at
// /guides/<slug> — everything pre-rendered into the bundle, nothing loaded at
// runtime.
import { guides } from './generated/content.ts';
import service from './service.ts';
import { guidePage, landingPage, notFoundPage } from './template.ts';

const port = service.port();

const bySlug = new Map(guides.map((g) => [g.slug, g]));

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });

export function handle(req: Request): Response {
  const { pathname } = new URL(req.url);

  if (pathname === '/') return html(landingPage(guides));

  const slug = pathname.match(/^\/guides\/([^/]+)\/?$/)?.[1];
  if (slug !== undefined) {
    const guide = bySlug.get(slug);
    if (guide) return html(guidePage(guide, guides));
  }

  return html(notFoundPage(guides), 404);
}

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handle });
