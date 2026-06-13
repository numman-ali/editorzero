import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import {
  AGENT_TOKEN_NAMED_TIERS,
  type AgentNamedTier,
  type AgentTokenMinted,
  type AgentTokenSummary,
  agentTokensQueryKey,
  agentTokensQueryOptions,
  isRevoked,
  lifecycleStatusLabel,
  lifecycleTagClass,
  mintAgentToken,
  revokeAgentToken,
  tokenDisplayId,
  tokenExpiryLabel,
  tokenScopeSummary,
} from "../lib/agents";
import { formatUpdated } from "../lib/docs";

import "./inline-form.css";

/**
 * The agent's credential panel — three cells in one screen region
 * (ADR 0044 Decision 7):
 *
 *   - `agent.token_list × Web UI`: the `.tt` table of the agent's bearer
 *     tokens (the audit-table idiom). Rows carry only display identity
 *     (`token_prefix` + `last4`) and the recorded tier/scopes — never
 *     anything verifiable.
 *   - `agent.token_mint × Web UI`: the header's "+ Mint token"
 *     affordance and the SHOW-ONCE reveal. The plaintext secret exists
 *     in exactly this one response and is never stored, logged, or
 *     audited (Decision 3) — the reveal makes that the user's one chance
 *     to copy it.
 *   - `agent.token_revoke × Web UI`: the per-row confirm (live tokens
 *     only) — the narrow "rotate one credential" verb, distinct from
 *     revoking the whole agent.
 *
 * `readOnly` is the revoked-agent state: revocation already cascaded to
 * every token, so the table is shown for the record but minting and
 * per-row revoke give way (no live credential remains to act on).
 *
 * Coverage: orchestration-only — the data layer lives unit-tested in
 * `lib/agents.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/credentials.spec.ts`).
 */
export function AgentTokens({ agentId, readOnly }: { agentId: string; readOnly: boolean }) {
  const { data } = useSuspenseQuery(agentTokensQueryOptions(agentId));
  const tokens = data.tokens;
  return (
    <section className="panel" aria-labelledby="tokens-heading" style={{ marginTop: "15px" }}>
      <div className="ph">
        <h2 className="t" id="tokens-heading">
          Tokens
        </h2>
        {!readOnly && (
          <div className="r">
            <MintToken agentId={agentId} />
          </div>
        )}
      </div>
      {tokens.length === 0 ? (
        <p className="ord" style={{ padding: "15px" }}>
          No tokens minted yet.
        </p>
      ) : (
        <table className="tt">
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Tier</th>
              <th scope="col">Scopes</th>
              <th scope="col">Created</th>
              <th scope="col">Expires</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <TokenRow key={token.token_id} agentId={agentId} token={token} readOnly={readOnly} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function TokenRow({
  agentId,
  token,
  readOnly,
}: {
  agentId: string;
  token: AgentTokenSummary;
  readOnly: boolean;
}) {
  const revoked = isRevoked(token);
  return (
    <tr>
      <td className="mono">{tokenDisplayId(token)}</td>
      <td>{token.tier}</td>
      <td className="when">{tokenScopeSummary(token)}</td>
      <td className="when">{formatUpdated(token.created_at)}</td>
      <td className="when">{tokenExpiryLabel(token, formatUpdated)}</td>
      <td>
        <span className="doc">
          <span className={lifecycleTagClass(revoked)}>{lifecycleStatusLabel(revoked)}</span>
          {!revoked && !readOnly && <RevokeToken agentId={agentId} tokenId={token.token_id} />}
        </span>
      </td>
    </tr>
  );
}

type MintState =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "minted"; token: AgentTokenMinted }
  | { kind: "failed" };

function MintToken({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<AgentNamedTier>("read-only");
  const [state, setState] = useState<MintState>({ kind: "idle" });

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind === "minting") return;
    setState({ kind: "minting" });
    try {
      const minted = await mintAgentToken(agentId, tier);
      // The new row must appear behind the reveal; refetch the list now so
      // it is ready when the reveal is dismissed.
      await queryClient.invalidateQueries({ queryKey: agentTokensQueryKey(agentId) });
      setState({ kind: "minted", token: minted });
    } catch {
      setState({ kind: "failed" });
    }
  }

  function reset(): void {
    // Dropping the reveal IS the point — the plaintext leaves memory and
    // is never recoverable. Return to the closed affordance.
    setOpen(false);
    setTier("read-only");
    setState({ kind: "idle" });
  }

  // The show-once reveal replaces the whole control until dismissed.
  if (state.kind === "minted") {
    return (
      <div className="token-reveal">
        <span className="inlineform-status">New token — copy it now</span>
        <code className="token-reveal-value">{state.token.token}</code>
        <p className="token-reveal-warn" role="alert">
          This is the only time the token is shown. Store it now — it cannot be retrieved later.
        </p>
        <button type="button" className="btn btn--ultra btn--sm" onClick={reset}>
          Done
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ultra btn--sm" onClick={() => setOpen(true)}>
        + Mint token
      </button>
    );
  }

  const minting = state.kind === "minting";
  return (
    <form className="inlineform" onSubmit={(event) => void handleSubmit(event)}>
      <select
        className="inlineform-select"
        aria-label="Token tier"
        value={tier}
        onChange={(event) => {
          // The option values come from AGENT_TOKEN_NAMED_TIERS verbatim, so
          // the change value is one of them by construction — find() narrows
          // without a cast.
          const next = AGENT_TOKEN_NAMED_TIERS.find((t) => t === event.target.value);
          if (next !== undefined) setTier(next);
        }}
        disabled={minting}
      >
        {AGENT_TOKEN_NAMED_TIERS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button type="submit" className="btn btn--ultra btn--sm" disabled={minting}>
        {minting ? "Minting…" : "Mint"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => {
          setOpen(false);
          setState({ kind: "idle" });
        }}
        disabled={minting}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          Mint failed. Try again.
        </span>
      ) : null}
    </form>
  );
}

type RevokeTokenState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "revoking" }
  | { kind: "failed" };

function RevokeToken({ agentId, tokenId }: { agentId: string; tokenId: string }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RevokeTokenState>({ kind: "idle" });

  async function handleConfirm(): Promise<void> {
    if (state.kind === "revoking") return;
    setState({ kind: "revoking" });
    try {
      await revokeAgentToken(tokenId);
      await queryClient.invalidateQueries({ queryKey: agentTokensQueryKey(agentId) });
      // The row re-renders as revoked; this control unmounts with it.
    } catch {
      setState({ kind: "failed" });
    }
  }

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => setState({ kind: "confirming" })}
      >
        Revoke
      </button>
    );
  }

  const revoking = state.kind === "revoking";
  return (
    <span className="inlineform">
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => void handleConfirm()}
        disabled={revoking}
      >
        {revoking ? "Revoking…" : "Confirm revoke"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setState({ kind: "idle" })}
        disabled={revoking}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          Revoke failed. Try again.
        </span>
      ) : null}
    </span>
  );
}
