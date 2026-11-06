/** How the email service delivers mail: through Resend, over SMTP, or not at all. */
export const emailDeliveryModes = ['resend', 'smtp', 'none'] as const;

export type EmailDeliveryMode = (typeof emailDeliveryModes)[number];
