/**
 * The two templates this example sends — declared and rendered
 * consumer-side (ADR-0005; the email module never runs this code, only the
 * rendered `subject`/`html`/`text` it produces). Interpolated values
 * (`name`, `link`) are user input — `name` comes straight from the signup
 * body, `link` carries a token this app minted but still lands inside an
 * `href` attribute — so both are HTML-escaped before going into markup.
 */
import { defineTemplates } from '@prisma/composer-prisma-cloud/email';
import { type } from 'arktype';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const templates = defineTemplates({
  welcome: {
    data: type({ name: 'string' }),
    render: ({ name }) => ({
      subject: `Welcome, ${name}!`,
      html: `<p>Welcome, ${escapeHtml(name)}!</p>`,
      text: `Welcome, ${name}!`,
    }),
  },
  verification: {
    data: type({ link: 'string' }),
    render: ({ link }) => ({
      subject: 'Verify your email',
      html: `<p><a href="${escapeHtml(link)}">Verify your email</a></p>`,
      text: `Verify your email: ${link}`,
    }),
  },
});
