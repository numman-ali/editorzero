import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { formatAuditTime } from "../lib/audit";
import {
  grantGrantedByLabel,
  grantGuestMarker,
  grantListInfiniteOptions,
  grantSubjectLabel,
} from "../lib/permissions";

import "./inline-form.css";

/**
 * The `permission.list × Web UI` cell: the doc screen's Sharing panel —
 * a read-only disclosure of the doc's ACL edges (the "who has access"
 * graph: subjects, roles, guest markers, grantor attribution,
 * timestamps). Administer-gated on the wire; raw ids by design (the
 * audit-screen exactness precedent — identity display is the
 * identity-resolution ADR's later upgrade, no wire change).
 *
 * A body-row disclosure (the EditCollection closed-row recipe), NOT a
 * header control: the open state renders a table, which has no place
 * inside the header's inline `.r` row. Fetches on open only (`enabled`)
 * — most doc visits never pay for the panel. Grant/revoke mutations
 * stay API/CLI/MCP until the identity cluster lands a subject picker
 * (`UI_PENDING`); this panel is the read half, honest about that.
 *
 * Coverage: orchestration-only — fetch/cursor/label policy lives
 * unit-tested in `lib/permissions.ts`; proven by the marked Playwright
 * spec (`packages/e2e/test/editor.spec.ts`).
 */
export function SharingDoc({ docId }: { docId: string }) {
  const hideRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    ...grantListInfiniteOptions("doc", docId),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      hideRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return (
      <div className="kv">
        <span className="k">Sharing</span>
        <span className="inlineform">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
            Show
          </button>
        </span>
      </div>
    );
  }

  const grants = query.data?.pages.flatMap((page) => page.grants) ?? [];
  return (
    <section aria-label="Sharing">
      <div className="kv">
        <span className="k">Sharing</span>
        <span className="inlineform">
          <button
            ref={hideRef}
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setOpen(false)}
          >
            Hide
          </button>
        </span>
      </div>
      {query.isPending ? (
        <p className="ord" style={{ padding: "15px" }}>
          Loading sharing…
        </p>
      ) : query.isError ? (
        <p className="ord" style={{ padding: "15px" }} role="alert">
          Couldn't load sharing. Try again.
        </p>
      ) : grants.length === 0 ? (
        <p className="ord" style={{ padding: "15px" }}>
          No explicit grants — access follows workspace and space roles.
        </p>
      ) : (
        <table className="tt">
          <thead>
            <tr>
              <th scope="col">Subject</th>
              <th scope="col">Role</th>
              <th scope="col">Marker</th>
              <th scope="col">Granted by</th>
              <th scope="col">When (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => {
              const marker = grantGuestMarker(grant);
              return (
                <tr key={grant.grant_id}>
                  <td className="when">{grantSubjectLabel(grant)}</td>
                  <td>{grant.role}</td>
                  <td>
                    {marker === null ? null : <span className="status-tag st-warn">{marker}</span>}
                  </td>
                  <td className="when">{grantGrantedByLabel(grant)}</td>
                  <td className="when">{formatAuditTime(grant.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {query.hasNextPage ? (
        <div style={{ padding: "15px" }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
