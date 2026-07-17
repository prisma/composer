import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  return (
    <main>
      <h1>TanStack Start on Prisma Composer</h1>
      <p>Rendered by the Nitro server from Composer's directory build adapter.</p>
      <a href="/composer.txt">Public asset</a>
    </main>
  );
}
