import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  AUDIT_LIST_QUERY_KEY,
  AUDIT_PAGE_SIZE,
  type AuditList,
  auditEventQueryKey,
  auditEventQueryOptions,
  auditListInfiniteOptions,
  auditOutcomeTagClass,
  auditPrincipalLabel,
  auditSubjectLabel,
  fetchAuditEvent,
  fetchAuditPage,
  formatAuditTime,
  isAuditEventMissing,
  shortId,
} from "./audit";

/**
 * Same fake-client pattern as `docs.test.ts`: a REAL typed client with an
 * injected fetch returning one canned response. The capturing variant also
 * records the request URL — `fetchAuditPage`'s cursor handling is QUERY
 * construction (`.strict()` wire schema: first page must OMIT the cursor
 * keys, not send empties), so the URL is the behavior under test.
 */
function capturingClient(status: number, body: unknown): { client: ApiClient; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { client: createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl }), urls };
}

function jsonClient(status: number, body: unknown): ApiClient {
  return capturingClient(status, body).client;
}

const EVENT = {
  id: "evt-00000000000000000001",
  workspace_id: "018f0000-0000-7000-8000-0000000000aa",
  capability_id: "doc.move",
  category: "mutation",
  principal_kind: "user",
  principal_id: "user-000000000000000001",
  acting_as_user_id: null,
  session_id: null,
  token_id: null,
  subject_kind: "doc",
  subject_id: "018f0000-0000-7000-8000-0000000000d1",
  outcome: "allow",
  deny_reason: null,
  input_hash: "sha256:0000",
  effect: { kind: "doc.moved" },
  duration_ms: 12,
  trace_id: null,
  created_at: Date.UTC(2026, 5, 12, 3, 14, 9),
  collapsed_count: 1,
};

const CURSOR = { before_created_at: EVENT.created_at, before_id: EVENT.id };
const PAGE = { events: [EVENT], next_cursor: CURSOR };
const LAST_PAGE = { events: [EVENT], next_cursor: null };

// Typed pages for exercising getNextPageParam directly: its parameter is the
// full derived AuditList (branded row ids and all) — empty `events` keeps the
// fixture honest without restating a wire row in branded form.
const TYPED_PAGE: AuditList = { events: [], next_cursor: CURSOR };
const TYPED_LAST: AuditList = { events: [], next_cursor: null };

describe("fetchAuditPage", () => {
  it("returns the typed page on 200 and asks for the head with limit only", async () => {
    const { client, urls } = capturingClient(200, PAGE);
    const result = await fetchAuditPage(null, client);
    expect(result.events[0]?.capability_id).toBe("doc.move");
    expect(result.next_cursor).toEqual(CURSOR);
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/audits/list");
    expect(url.searchParams.get("limit")).toBe(String(AUDIT_PAGE_SIZE));
    expect(url.searchParams.has("before_created_at")).toBe(false);
    expect(url.searchParams.has("before_id")).toBe(false);
  });

  it("sends both cursor keys when paging past the head", async () => {
    const { client, urls } = capturingClient(200, LAST_PAGE);
    await fetchAuditPage(CURSOR, client);
    const url = new URL(urls[0] ?? "");
    expect(url.searchParams.get("before_created_at")).toBe(String(CURSOR.before_created_at));
    expect(url.searchParams.get("before_id")).toBe(CURSOR.before_id);
  });

  it("throws a typed ApiError on the admin-gate 403", async () => {
    await expect(
      fetchAuditPage(null, jsonClient(403, { error: "permission_denied" })),
    ).rejects.toThrow(new ApiError(403, "permission_denied"));
  });
});

describe("auditListInfiniteOptions", () => {
  it("keys the cache, starts at the head, and chains the wire cursor", async () => {
    const options = auditListInfiniteOptions(jsonClient(200, PAGE));
    expect(options.queryKey).toEqual(AUDIT_LIST_QUERY_KEY);
    expect(options.initialPageParam).toBeNull();
    expect(options.getNextPageParam(TYPED_PAGE, [TYPED_PAGE], null, [null])).toEqual(CURSOR);
    // Drive the queryFn through a real QueryClient (the docs.test.ts
    // pattern — its context parameter is library-internal).
    const result = await new QueryClient().fetchInfiniteQuery(options);
    expect(result.pages[0]?.events[0]?.id).toBe(EVENT.id);
  });

  it("ends the sequence when next_cursor is null", () => {
    const options = auditListInfiniteOptions(jsonClient(200, LAST_PAGE));
    expect(options.getNextPageParam(TYPED_LAST, [TYPED_LAST], null, [null])).toBeNull();
  });
});

describe("fetchAuditEvent", () => {
  it("returns the typed row on 200", async () => {
    const { client, urls } = capturingClient(200, EVENT);
    const result = await fetchAuditEvent(EVENT.id, client);
    expect(result.id).toBe(EVENT.id);
    expect(result.effect.kind).toBe("doc.moved");
    expect(new URL(urls[0] ?? "").pathname).toBe(`/audits/get/${EVENT.id}`);
  });

  it("throws a typed ApiError on 404", async () => {
    await expect(
      fetchAuditEvent("evt-gone", jsonClient(404, { error: "not_found" })),
    ).rejects.toThrow(new ApiError(404, "not_found"));
  });
});

describe("auditEventQueryOptions", () => {
  it("keys the cache per event id and fetches through the queryFn", async () => {
    expect(auditEventQueryKey("evt-1")).toEqual(["audit.get", "evt-1"]);
    const options = auditEventQueryOptions(EVENT.id, jsonClient(200, EVENT));
    expect(options.queryKey).toEqual(["audit.get", EVENT.id]);
    const result = await new QueryClient().fetchQuery(options);
    expect(result.capability_id).toBe("doc.move");
  });
});

describe("isAuditEventMissing", () => {
  it("matches the 404 (absent/pruned) and 400 (malformed UUIDv7 param) arms only", () => {
    expect(isAuditEventMissing(new ApiError(404, "not_found"))).toBe(true);
    expect(isAuditEventMissing(new ApiError(400, "validation_failed"))).toBe(true);
    expect(isAuditEventMissing(new ApiError(403, "permission_denied"))).toBe(false);
    expect(isAuditEventMissing(new Error("boom"))).toBe(false);
  });
});

describe("formatAuditTime", () => {
  it("renders UTC at second precision", () => {
    expect(formatAuditTime(Date.UTC(2026, 5, 12, 3, 14, 9))).toBe("2026-06-12 03:14:09");
    expect(formatAuditTime(0)).toBe("1970-01-01 00:00:00");
  });
});

describe("auditOutcomeTagClass", () => {
  it("greens allow; deny and error share the warn chip", () => {
    expect(auditOutcomeTagClass("allow")).toBe("status-tag st-pub");
    expect(auditOutcomeTagClass("deny")).toBe("status-tag st-warn");
    expect(auditOutcomeTagClass("error")).toBe("status-tag st-warn");
  });
});

describe("shortId", () => {
  it("keeps short ids whole and abbreviates long ones", () => {
    expect(shortId("0123456789")).toBe("0123456789");
    expect(shortId("0123456789a")).toBe("01234567…");
  });
});

describe("labels", () => {
  it("renders subject kind alone when subject_id is null", () => {
    expect(auditSubjectLabel({ subject_kind: "workspace", subject_id: null })).toBe("workspace");
    expect(auditSubjectLabel({ subject_kind: "doc", subject_id: EVENT.subject_id })).toBe(
      "doc 018f0000…",
    );
  });

  it("renders principal as kind + abbreviated id", () => {
    expect(auditPrincipalLabel({ principal_kind: "user", principal_id: "u-1" })).toBe("user u-1");
    expect(auditPrincipalLabel({ principal_kind: "user", principal_id: EVENT.principal_id })).toBe(
      "user user-000…",
    );
  });
});
