/**
 * The HTML shell and the two page bodies (landing, guide). Pure string
 * builders — no framework, no client JS. Styling is one embedded stylesheet;
 * code blocks are pre-highlighted by shiki with light/dark CSS variables, so
 * the theme rule here is all the runtime theming there is.
 */
import type { Guide } from './generated/content.ts';

const REPO = 'https://github.com/prisma/composer';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1a1f36; --muted: #5a6478; --border: #e5e8ef;
  --accent: #16a394; --accent-fg: #ffffff; --card: #f7f8fa; --code-bg: #f6f8fa;
  /* Ambient background wash. Light mode stays faint — over white, teal reads
     loud fast, so these are deliberately weaker than their dark counterparts. */
  --glow-a: rgba(22, 163, 148, 0.18);
  --glow-b: rgba(45, 212, 191, 0.14);
  --glow-c: rgba(26, 31, 54, 0.07);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161c; --fg: #e6e8ee; --muted: #9aa3b5; --border: #262a35;
    --accent: #2dd4bf; --accent-fg: #06231f; --card: #1b1e26; --code-bg: #1b1e26;
    --glow-a: rgba(45, 212, 191, 0.16);
    --glow-b: rgba(20, 184, 166, 0.12);
    --glow-c: rgba(76, 110, 245, 0.10);
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 5rem; }
body {
  margin: 0; color: var(--fg);
  background-color: var(--bg);
  /* Three soft clouds, anchored to the viewport rather than the page, so they
     read as ambient depth instead of a banner that scrolls away. */
  background-image:
    radial-gradient(58rem 30rem at 50% -12%, var(--glow-a), transparent 66%),
    radial-gradient(42rem 26rem at 92% 4%, var(--glow-b), transparent 62%),
    radial-gradient(46rem 30rem at 2% 26%, var(--glow-c), transparent 64%);
  background-attachment: fixed;
  background-repeat: no-repeat;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top {
  position: sticky; top: 0; z-index: 10; display: flex; align-items: center;
  justify-content: space-between; gap: 1rem; padding: 0.9rem 1.5rem;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--border);
}
header.top .brand { font-weight: 700; color: var(--fg); letter-spacing: -0.01em; }
header.top .brand span { color: var(--accent); }
header.top nav a { color: var(--muted); margin-left: 1.25rem; font-size: 0.92rem; }
.layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 2.5rem;
  max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem 5rem; }
aside.sidebar { position: sticky; top: 5rem; align-self: start; }
aside.sidebar .label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); margin: 0 0 0.6rem; }
aside.sidebar ul { list-style: none; margin: 0; padding: 0; }
aside.sidebar li { margin: 0.1rem 0; }
aside.sidebar a { display: block; padding: 0.35rem 0.6rem; border-radius: 6px; color: var(--fg);
  font-size: 0.94rem; }
aside.sidebar a:hover { background: var(--card); text-decoration: none; }
aside.sidebar a.active { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
main { min-width: 0; }
main.content h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 1.2rem; }
main.content h2 { font-size: 1.4rem; letter-spacing: -0.01em; margin: 2.4rem 0 0.8rem;
  padding-top: 0.4rem; }
main.content h3 { font-size: 1.1rem; margin: 1.8rem 0 0.6rem; }
main.content table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.94rem; }
main.content th, main.content td { border: 1px solid var(--border); padding: 0.5rem 0.75rem;
  text-align: left; vertical-align: top; }
main.content th { background: var(--card); }
main.content blockquote { margin: 1rem 0; padding: 0.2rem 1rem; border-left: 3px solid var(--accent);
  color: var(--muted); }
main.content :not(pre) > code {
  background: var(--code-bg); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.88em;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
main.content pre { padding: 1rem 1.15rem; border-radius: 8px; overflow-x: auto;
  border: 1px solid var(--border); font-size: 0.86rem; line-height: 1.55; }
.shiki, .shiki span { color: var(--shiki-light); background-color: var(--shiki-light-bg); }
@media (prefers-color-scheme: dark) {
  .shiki, .shiki span { color: var(--shiki-dark); background-color: var(--shiki-dark-bg); }
}
/* hero + cards (landing) */
.hero { max-width: 820px; margin: 0 auto; padding: 4.5rem 1.5rem 2rem; text-align: center; }
.hero h1 { font-size: clamp(2.2rem, 5vw, 3.2rem); letter-spacing: -0.03em; margin: 0 0 1rem;
  line-height: 1.08; text-wrap: balance; }
.hero h1 .hl { color: var(--accent); }
.hero p { font-size: 1.15rem; color: var(--muted); max-width: 620px; margin: 0 auto 2rem; }
.install { display: inline-flex; align-items: center; gap: 0.75rem;
  background: color-mix(in srgb, var(--card) 78%, transparent);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem 1.1rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92rem; }
.install .prompt { color: var(--accent); }
.hero .sub { font-size: 0.95rem; margin: 1.25rem auto 0; max-width: 560px; }
.why { max-width: 900px; margin: 3rem auto 0; padding: 0 1.5rem;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 1.75rem; }
.why-item .n { font-weight: 650; margin-bottom: 0.35rem; letter-spacing: -0.01em;
  color: var(--accent); }
.why-item .d { color: var(--muted); font-size: 0.9rem; line-height: 1.55; }
.why-item code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px;
  font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cards { max-width: 900px; margin: 2.5rem auto; padding: 0 1.5rem;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
.card { display: block; padding: 1.25rem 1.4rem; border: 1px solid var(--border); border-radius: 10px;
  background: color-mix(in srgb, var(--card) 78%, transparent);
  backdrop-filter: blur(6px);
  color: var(--fg); transition: border-color 0.15s, transform 0.15s; }
.card:hover { border-color: var(--accent); text-decoration: none; transform: translateY(-2px); }
.card .n { font-weight: 650; margin-bottom: 0.3rem; letter-spacing: -0.01em; }
.card .d { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
footer.foot { border-top: 1px solid var(--border); text-align: center; color: var(--muted);
  font-size: 0.86rem; padding: 2rem 1.5rem; }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  aside.sidebar { position: static; }
}
`;

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Getting-started documentation for Prisma Composer — build and deploy multi-service TypeScript apps to Prisma Cloud.">
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/">Prisma <span>Composer</span></a>
  <nav>
    <a href="/guides/getting-started">Guides</a>
    <a href="${REPO}">GitHub</a>
  </nav>
</header>
${bodyHtml}
<footer class="foot">Prisma Composer · rendered from <a href="${REPO}/tree/main/docs/guides">docs/guides</a></footer>
</body>
</html>`;
}

function sidebar(guides: readonly Guide[], activeSlug: string): string {
  const items = guides
    .map(
      (g) =>
        `<li><a href="/guides/${g.slug}"${g.slug === activeSlug ? ' class="active"' : ''}>${escapeHtml(
          g.title,
        )}</a></li>`,
    )
    .join('\n');
  return `<aside class="sidebar"><p class="label">Guides</p><ul>${items}</ul></aside>`;
}

const CARD_BLURB: Record<string, string> = {
  'getting-started':
    'Empty directory to a deployed two-service app. Plus porting an app you already have.',
  'building-an-app':
    'Contracts, databases, reusable Modules, cron and storage, config, and secrets.',
  testing: 'Unit tests with mockService; integration tests with bootstrapService.',
  deploying: 'Stages, destroy, CI, and how your app behaves in production.',
};

export function landingPage(guides: readonly Guide[]): string {
  const cards = guides
    .map(
      (g) =>
        `<a class="card" href="/guides/${g.slug}"><div class="n">${escapeHtml(
          g.title,
        )}</div><div class="d">${escapeHtml(CARD_BLURB[g.slug] ?? '')}</div></a>`,
    )
    .join('\n');

  const body = `
<section class="hero">
  <h1>The <span class="hl">fastest</span>, <span class="hl">most reliable</span> way to <span class="hl">build an app</span> with your agent.</h1>
  <p>Start from scratch and deploy the whole thing — services, databases, and the wiring between them — to Prisma Cloud in minutes.</p>
  <div class="install"><span class="prompt">$</span> npx skills add prisma/composer</div>
  <p class="sub">Start here. Your agent arrives knowing the whole API and the building blocks it can snap together — then you describe what you want.</p>
</section>
<div class="why">
  <div class="why-item"><div class="n">Modules snap together</div><div class="d">A capability arrives as a Module that owns its internals behind a typed port. Composition, not an integration your agent has to invent.</div></div>
  <div class="why-item"><div class="n">Everything is typechecked</div><div class="d">A wrong wire, a missing handler, a bad config shape — none of it compiles. Mistakes fail <code>tsc</code> in seconds, not a deploy ten minutes later.</div></div>
  <div class="why-item"><div class="n">Deploys are deterministic</div><div class="d">One command, no infrastructure config to hallucinate, and re-running it converges instead of drifting.</div></div>
</div>
<div class="cards">
${cards}
</div>`;
  return shell('Prisma Composer — Docs', body);
}

export function guidePage(guide: Guide, guides: readonly Guide[]): string {
  const body = `<div class="layout">
${sidebar(guides, guide.slug)}
<main class="content">${guide.html}</main>
</div>`;
  return shell(`${guide.title} — Prisma Composer`, body);
}

export function notFoundPage(guides: readonly Guide[]): string {
  const body = `<div class="hero"><h1>Not found</h1><p>That page doesn't exist. Try the <a href="/guides/getting-started">getting-started guide</a>.</p></div>`;
  void guides;
  return shell('Not found — Prisma Composer', body);
}
