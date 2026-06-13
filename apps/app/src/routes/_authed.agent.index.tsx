import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NewAgent } from "../components/new-agent";
import {
  agentListQueryOptions,
  isRevoked,
  lifecycleStatusLabel,
  lifecycleTagClass,
} from "../lib/agents";
import { formatUpdated } from "../lib/docs";

/**
 * `/agent` — the Agents screen: the `agent.list × Web UI` parity cell
 * (invariant 4 + invariant 8, ADR 0044 Decision 7). Same loader/component
 * split as the spaces cell: `ensureQueryData` warms the cache (a failed
 * list lands in the route error boundary), `useSuspenseQuery` reads it
 * back.
 *
 * SINGULAR route on purpose: `/agents` is the trunk's API domain and a
 * reserved prefix (ADR 0035 §2 / 0044) — the same resolution `/space`,
 * `/doc`, and `/audit` made against their plural API domains.
 *
 * Agents are NAME-addressed principals — no user picker, no identity
 * cluster: the screen needs nothing the resolution ADR is still settling.
 * Each card's NAME links into the agent's detail screen
 * (`/agent/$agentId`, the `agent.get` cell) where credentials are
 * minted; revoked agents stay listed (terminal-but-visible) carrying a
 * Revoked chip.
 *
 * Coverage: render-only by design — every decision (query options,
 * lifecycle labels/chips) lives unit-tested in `lib/agents.ts`; this file
 * is in the e2e-covered set, proven by the marked Playwright spec
 * (`packages/e2e/test/credentials.spec.ts`, `proves-capability-cell:
 * agent.list`).
 */
export const Route = createFileRoute("/_authed/agent/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(agentListQueryOptions()),
  component: Agents,
});

function Agents() {
  const { data } = useSuspenseQuery(agentListQueryOptions());
  const agents = data.agents;
  return (
    <section className="panel" aria-labelledby="agents-heading">
      <div className="ph">
        <h2 className="t" id="agents-heading">
          Agents
        </h2>
        <div className="r">
          {/* The agent.create cell — create→detail, the new-doc pattern. */}
          <NewAgent />
        </div>
      </div>
      {agents.length === 0 ? (
        <p className="ord" style={{ padding: "15px" }}>
          No agents yet.
        </p>
      ) : (
        <ul className="spaces" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {agents.map((agent, index) => {
            const revoked = isRevoked(agent);
            return (
              <li className="sp" key={agent.agent_id}>
                <div className="ord">AG·{String(index + 1).padStart(2, "0")}</div>
                <div className="nm">
                  <Link to="/agent/$agentId" params={{ agentId: agent.agent_id }}>
                    {agent.name}
                  </Link>
                </div>
                <div className="ds mono">{agent.agent_id}</div>
                <div className="ft">
                  <span className={lifecycleTagClass(revoked)}>
                    {lifecycleStatusLabel(revoked)}
                  </span>
                  <span className="ord">created {formatUpdated(agent.created_at)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
