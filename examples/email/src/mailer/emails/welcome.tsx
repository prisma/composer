/**
 * The welcome email as a react-email component — the second authoring
 * style this example demonstrates, alongside `verification`'s plain
 * function in `templates.tsx`. `{name}` is user input from the signup
 * body; JSX interpolation auto-escapes it (React escapes text children by
 * construction), which is part of what this demo shows — no `escapeHtml`
 * call needed here, unlike the plain-function template.
 */
import { Body, Container, Html, Text } from '@react-email/components';

export interface WelcomeEmailProps {
  readonly name: string;
}

export function WelcomeEmail({ name }: WelcomeEmailProps) {
  return (
    <Html lang="en">
      <Body>
        <Container>
          <Text>Welcome, {name}!</Text>
        </Container>
      </Body>
    </Html>
  );
}
