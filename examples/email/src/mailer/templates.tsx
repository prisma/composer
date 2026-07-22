/**
 * The two templates this example sends — declared and rendered
 * consumer-side (ADR-0005; the email module never runs this code, only the
 * rendered `subject`/`html`/`text` it produces). Two authoring styles side
 * by side: `welcome` is a react-email component (`render` is async —
 * `TemplateDef.render` accepts either, spec's 2026-07-22 amendment);
 * `verification` is a plain function. `link` is user input (a token this
 * app minted, but still landing inside an `href` attribute), so it's
 * HTML-escaped before going into markup.
 */
import { defineTemplates } from '@prisma/composer-prisma-cloud/email';
import { render } from '@react-email/render';
import { type } from 'arktype';
import { WelcomeEmail } from './emails/welcome.tsx';

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
    render: async ({ name }) => ({
      subject: `Welcome, ${name}!`,
      html: await render(<WelcomeEmail name={name} />),
      text: await render(<WelcomeEmail name={name} />, { plainText: true }),
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
