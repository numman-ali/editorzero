import { createFileRoute } from "@tanstack/react-router";

/**
 * `/` — the app home, now nested under the authed layout (`_authed`), so it
 * renders inside the shell `<main>` and only reaches a signed-in principal.
 * Placeholder body until the `doc.list × Web UI` parity cell (the next #13
 * increment) replaces it with the real Space landing (ADR 0040 vocabulary:
 * "Space" in the UI; the API call underneath hits `/workspaces` + `/docs`).
 */
export const Route = createFileRoute("/_authed/")({
  component: Home,
});

function Home() {
  return <p className="ord">Home — the Space landing arrives with the doc.list parity cell.</p>;
}
