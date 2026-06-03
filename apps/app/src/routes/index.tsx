import { createFileRoute } from "@tanstack/react-router";

/**
 * `/` — the app home. Placeholder body until the doc.list parity cell (the
 * next #13 increment) replaces it with the real workspace landing.
 */
export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <main>editorzero</main>;
}
