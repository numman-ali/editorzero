import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import {
  auditEventQueryOptions,
  auditOutcomeTagClass,
  formatAuditTime,
  isAuditEventMissing,
} from "../lib/audit";

/**
 * `/audit/$auditId` — one event, in full: the `audit.get × Web UI`
 * parity cell (invariant 4). The list abbreviates ids; this screen IS
 * the forensic record, so every field renders verbatim — raw ids are
 * the honest content here (the user-identity-resolution gap blocks
 * humane principal names everywhere, but an audit record's job is
 * exactness, not warmth). Null fields render as "—": the field
 * existing with no value is itself a forensic fact.
 *
 * The loader maps the wire 404 (absent or retention-pruned id) AND the
 * wire 400 (the param validates as strict UUIDv7 — a malformed link can
 * never address an event) to the router's notFound; everything else
 * stays an error-boundary error. `effect` is capability-shaped beyond
 * its `kind`, so it renders as pretty-printed JSON — the only honest
 * projection of an open record.
 *
 * Coverage: render-only — decisions live unit-tested in `lib/audit.ts`;
 * proven by the marked Playwright spec (`packages/e2e/test/trail.spec.ts`,
 * `proves-capability-cell: audit.get`).
 */
export const Route = createFileRoute("/_authed/audit/$auditId")({
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(auditEventQueryOptions(params.auditId));
    } catch (error) {
      if (isAuditEventMissing(error)) {
        throw notFound();
      }
      throw error;
    }
  },
  notFoundComponent: AuditEventNotFound,
  component: AuditEventScreen,
});

function AuditEventNotFound() {
  return (
    <section className="panel" aria-labelledby="audit-missing-heading">
      <div className="ph">
        <h2 className="t" id="audit-missing-heading">
          No such audit event
        </h2>
      </div>
      <p className="ord" style={{ padding: "15px" }}>
        This event does not exist in the trail — the id may have been pruned by trash retention, or
        the link was mistyped. <Link to="/audit">Back to the trail.</Link>
      </p>
    </section>
  );
}

/** A `.kv` fact row; null renders as "—" (see the header comment). */
function Fact({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v mono">{v ?? "—"}</span>
    </div>
  );
}

function AuditEventScreen() {
  const { auditId } = Route.useParams();
  const { data: event } = useSuspenseQuery(auditEventQueryOptions(auditId));
  return (
    <section className="panel" aria-labelledby="audit-event-heading">
      <div className="ph">
        <h2 className="t" id="audit-event-heading">
          {event.capability_id}
        </h2>
        <span className="pth">{event.id}</span>
        <div className="r">
          <span className={auditOutcomeTagClass(event.outcome)}>{event.outcome}</span>
        </div>
      </div>
      <div style={{ padding: "15px" }}>
        <Fact k="when (utc)" v={formatAuditTime(event.created_at)} />
        <Fact k="category" v={event.category} />
        <Fact k="outcome" v={event.outcome} />
        <Fact k="deny reason" v={event.deny_reason} />
        <Fact k="principal" v={`${event.principal_kind} ${event.principal_id}`} />
        <Fact k="acting as user" v={event.acting_as_user_id} />
        <Fact k="session" v={event.session_id} />
        <Fact k="token" v={event.token_id} />
        <Fact
          k="subject"
          v={
            event.subject_id === null
              ? event.subject_kind
              : `${event.subject_kind} ${event.subject_id}`
          }
        />
        <Fact k="input hash" v={event.input_hash} />
        <Fact k="duration" v={`${event.duration_ms} ms`} />
        <Fact k="trace" v={event.trace_id} />
        <Fact k="collapsed" v={`×${event.collapsed_count}`} />
        <Fact k="effect kind" v={event.effect.kind} />
        <pre
          className="mono"
          style={{ margin: "12px 0 0", padding: "12px 15px", fontSize: "11px", overflowX: "auto" }}
        >
          {JSON.stringify(event.effect, null, 2)}
        </pre>
      </div>
    </section>
  );
}
