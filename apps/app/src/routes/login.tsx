import { createFileRoute } from "@tanstack/react-router";

/**
 * `/login` — sign-in. Placeholder body until the api-client sign-in increment
 * wires Better Auth (ADR 0030) through `packages/api-client` (ADR 0028).
 */
export const Route = createFileRoute("/login")({
  component: Login,
});

function Login() {
  return <main>Sign in</main>;
}
