import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentTokens } from "../components/agent-tokens";
import { EditAgent } from "../components/edit-agent";
import { RevokeAgent } from "../components/revoke-agent";
import {
  agentQueryOptions,
  agentTokensQueryOptions,
  isRevoked,
  lifecycleStatusLabel,
  lifecycleTagClass,
} from "../lib/agents";

/**
 * `/agent/$agentId` — the agent detail screen: the `agent.get × Web UI`
 * parity cell (invariant 4 + invariant 8, ADR 0044 Decision 7), and the
 * host for the agent's mutation + credential cells. Reached from the
 * roster (each card's name links here).
 *
 * The loader warms BOTH the agent row AND its token list in parallel
 * (`Promise.all` — no client-side waterfall, and an invisible agent's
 * 404 rejects before any chrome renders), so the two panels read warm
 * cache via `useSuspenseQuery`.
 *
 * Two panels: the identity/edit panel (name + lifecycle chip, the `.kv`
 * facts with the `agent.update` rename disclosure and the `agent.revoke`
 * confirm), and the credential panel (`AgentTokens` — list + mint +
 * per-token revoke). A REVOKED agent renders both read-only: the row is
 * terminal-but-visible, but revocation already cascaded to its tokens,
 * so no further mutation is offered (the `readOnly` path).
 *
 * Coverage: render-only — decisions (query options, lifecycle
 * labels/chips, token display helpers) live unit-tested in
 * `lib/agents.ts`. Proven by the marked Playwright spec
 * (`packages/e2e/test/credentials.spec.ts`, `proves-capability-cell:
 * agent.get`).
 */
export const Route = createFileRoute("/_authed/agent/$agentId")({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(agentQueryOptions(params.agentId)),
      context.queryClient.ensureQueryData(agentTokensQueryOptions(params.agentId)),
    ]),
  component: AgentScreen,
});

function AgentScreen() {
  const { agentId } = Route.useParams();
  const { data: agent } = useSuspenseQuery(agentQueryOptions(agentId));
  const revoked = isRevoked(agent);
  return (
    <>
      <section className="panel" aria-labelledby="agent-heading">
        <div className="ph">
          <h2 className="t" id="agent-heading">
            {agent.name}
          </h2>
          <div className="r">
            <span className={lifecycleTagClass(revoked)}>{lifecycleStatusLabel(revoked)}</span>
          </div>
        </div>
        <EditAgent agent={agent} readOnly={revoked}>
          {/* The agent.revoke cell — terminal, cascades to every token. */}
          <RevokeAgent agentId={agentId} />
        </EditAgent>
      </section>
      <AgentTokens agentId={agentId} readOnly={revoked} />
    </>
  );
}
