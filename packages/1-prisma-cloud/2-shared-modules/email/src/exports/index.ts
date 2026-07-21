/**
 * `@internal/email`'s authoring barrel: the wire contracts, template
 * declarations, the `emailSender()` dependency, and the `email()` module.
 * The runtime engine (stores, handlers, delivery, entrypoint) stays OUT of
 * this barrel, so a consumer graph that imports this module never bundles a
 * `node:`/`bun` token or nodemailer.
 */
export type { EmailSender, RenderedEmail, TemplateDef, TemplateDefs } from '../contract.ts';
export {
  defineTemplates,
  emailOutboxContract,
  emailSendContract,
  emailSender,
} from '../contract.ts';
export { email } from '../email-module.ts';
export { emailService } from './email-service.ts';
