/**
 * `audit.list` + `audit.get` data-layer — the `/audit` forensic screen's
 * capability cells (invariant 4, ADR 0033 §3 / 0040 H11).
 *
 * Same split as `docs.ts`/`spaces.ts`: plain testable fetchers + the
 * react-query bindings the routes consume, with every display decision
 * (timestamps, outcome chips, id abbreviation, subject/principal labels)
 * here so the route files stay render-only.
 *
 * `audit.list` is the app's FIRST cursor-paginated cell: the wire cursor
 * is `{before_created_at, before_id}` (both-or-neither — the schema
 * refines it), `next_cursor: null` means the trail is exhausted, and the
 * binding is `infiniteQueryOptions` (`getNextPageParam` returns the wire
 * cursor verbatim; `null` ends the sequence — react-query v5 treats it
 * as "no next page"). `AUDIT_PAGE_SIZE` is 25, deliberately under the
 * wire default of 50: a browser page the eye can scan, and small enough
 * that any real workspace trail paginates (the e2e proof clicks "Load
 * more" unconditionally).
 *
 * Both capabilities require `workspace:admin`. There is no 403 classify
 * vocabulary here on purpose: the registration gate (ADR 0041) means the
 * only browser principal today IS the genesis owner, so a denied arm
 * would be dead chrome — the loader's thrown `ApiError` lands in the
 * route error boundary if it ever happens. `audit.get`'s 404 IS
 * reachable (a deep link outliving the retention sweep), so it gets a
 * predicate (`isAuditEventMissing`) the detail loader maps to notFound.
 *
 * Types are DERIVED from the materialized client type (SSOT — the wire
 * schemas `AuditListOutputSchema`/`AuditGetOutputSchema` are server-side;
 * the `hc` client type is the browser-safe projection). Branded id
 * fields stay branded because apps/app declares `@editorzero/ids`.
 */
import { type ApiClient, ApiError, isApiError } from "@editorzero/api-client";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

type AuditListResponse = Awaited<ReturnType<ApiClient["audits"]["list"]["$get"]>>;
// Typed error envelopes ride alongside the 200 — extract the success arm
// by its literal status before deriving the body (the docs.ts pattern).
type AuditListSuccess = Extract<AuditListResponse, { status: 200 }>;
export type AuditList = Awaited<ReturnType<AuditListSuccess["json"]>>;
export type AuditEvent = AuditList["events"][number];
export type AuditCursor = NonNullable<AuditList["next_cursor"]>;

type AuditGetResponse = Awaited<ReturnType<ApiClient["audits"]["get"][":audit_id"]["$get"]>>;
type AuditGetSuccess = Extract<AuditGetResponse, { status: 200 }>;
export type AuditEventDetail = Awaited<ReturnType<AuditGetSuccess["json"]>>;

/** Browser page size — see the header comment for why it undercuts the wire default. */
export const AUDIT_PAGE_SIZE = 25;

export const AUDIT_LIST_QUERY_KEY = ["audit.list"] as const;

/**
 * Fetch one page of the trail, newest first. `cursor` is the previous
 * page's `next_cursor`; `null` asks for the head. Cursor keys are omitted
 * entirely on the first page — the input schema is `.strict()` and
 * refines the pair to both-or-neither.
 */
export async function fetchAuditPage(
  cursor: AuditCursor | null,
  client: ApiClient = apiClient,
): Promise<AuditList> {
  const res = await client.audits.list.$get({
    query: {
      limit: String(AUDIT_PAGE_SIZE),
      ...(cursor !== null && {
        before_created_at: String(cursor.before_created_at),
        before_id: cursor.before_id,
      }),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

/** Typed `null` so `initialPageParam` infers `AuditCursor | null`, not `null`. */
const FIRST_PAGE: AuditCursor | null = null;

export function auditListInfiniteOptions(client: ApiClient = apiClient) {
  return infiniteQueryOptions({
    queryKey: AUDIT_LIST_QUERY_KEY,
    queryFn: ({ pageParam }) => fetchAuditPage(pageParam, client),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });
}

export function auditEventQueryKey(auditId: string): readonly [string, string] {
  return ["audit.get", auditId] as const;
}

export async function fetchAuditEvent(
  auditId: string,
  client: ApiClient = apiClient,
): Promise<AuditEventDetail> {
  const res = await client.audits.get[":audit_id"].$get({ param: { audit_id: auditId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function auditEventQueryOptions(auditId: string, client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: auditEventQueryKey(auditId),
    queryFn: () => fetchAuditEvent(auditId, client),
  });
}

/**
 * The detail loader's notFound arm. 404: an id that never existed or
 * was swept by retention-aligned pruning. 400: the wire validates
 * `audit_id` as a strict UUIDv7, so a malformed URL param can never
 * address an event — same answer for the person holding the link.
 * Anything else stays an error-boundary error.
 */
export function isAuditEventMissing(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 400);
}

/**
 * Forensic timestamps render as UTC `YYYY-MM-DD HH:MM:SS` — second
 * precision, machine-independent (the column header says UTC). Locale
 * rendering would make the same trail read differently on two admin
 * screens; a forensic plane wants one answer.
 */
export function formatAuditTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Outcome chip: `allow` rides the ok/green publish token; `deny` and
 * `error` share the warn chip — the chip TEXT carries the distinction
 * (color is never the only channel, WCAG 1.4.1).
 */
export function auditOutcomeTagClass(outcome: AuditEvent["outcome"]): string {
  return outcome === "allow" ? "status-tag st-pub" : "status-tag st-warn";
}

/** List-column id abbreviation; the detail screen renders ids in full. */
export function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

/** `subject_id` is null for workspace-shaped subjects — the kind alone is the label. */
export function auditSubjectLabel(ev: Pick<AuditEvent, "subject_kind" | "subject_id">): string {
  return ev.subject_id === null ? ev.subject_kind : `${ev.subject_kind} ${shortId(ev.subject_id)}`;
}

export function auditPrincipalLabel(
  ev: Pick<AuditEvent, "principal_kind" | "principal_id">,
): string {
  return `${ev.principal_kind} ${shortId(ev.principal_id)}`;
}
