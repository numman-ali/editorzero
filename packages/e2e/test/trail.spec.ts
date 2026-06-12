import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * The /audit forensic screens — the audit.list + audit.get × Web UI
 * parity cells (ADR 0040 H11):
 *
 *   proves-capability-cell: audit.list
 *   proves-capability-cell: audit.get
 *
 * NAMED trail.spec.ts ON PURPOSE — NOT audit.spec.ts. Specs run
 * alphabetically in one worker against one shared SQLite file, and
 * auth.spec.ts must run first (genesis sign-up provisions the only
 * account). Any `audit*` filename sorts BEFORE `auth` ('d' < 'h') and
 * would hit an empty database. The late t-slot also carries substance:
 * by now the trail holds every prior spec's real reads and mutations
 * (collections, docs, the editor's doc.move dance, the spaces
 * lifecycle) — exactly what a forensic screen should be proven against,
 * and what makes the pagination affordance unconditional (reads are
 * audited too, so the trail is far past one 25-row page).
 *
 * Both capabilities require workspace:admin — the genesis founder
 * passes (ADR 0041 bootstraps owner membership). Probe events are
 * minted over the same wire surface every principal uses
 * (POST /docs/create + /docs/delete/:id), pinning fresh known rows at
 * the head of the newest-first trail without disturbing fixture state
 * (probe docs are soft-deleted; doc.list hides them).
 */

test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

/** Create + soft-delete a probe doc; returns its id (two head-of-trail events). */
async function mintProbeEvents(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/docs/create", { data: { title } });
  expect(created.ok()).toBe(true);
  const doc: { doc_id?: string } = await created.json();
  expect(doc.doc_id).toBeTruthy();
  const trashed = await page.request.post(`/docs/delete/${doc.doc_id}`);
  expect(trashed.ok()).toBe(true);
  return doc.doc_id ?? "";
}

test("audit.list: nav reaches /audit; probe mutations render at the head; Load more extends the trail", async ({
  page,
}) => {
  await signIn(page);
  await mintProbeEvents(page, "Trail probe");

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Audit" })
    .click();
  await expect(page).toHaveURL(/\/audit$/);

  // First page is exactly AUDIT_PAGE_SIZE rows, newest first; the probe
  // events sit at the head (doc.delete above doc.create).
  const rows = page.locator(".tt tbody tr");
  await expect(rows).toHaveCount(25);
  const deleteRow = rows.filter({ has: page.getByRole("link", { name: "doc.delete" }) }).first();
  await expect(deleteRow).toBeVisible();
  await expect(
    rows.filter({ has: page.getByRole("link", { name: "doc.create" }) }).first(),
  ).toBeVisible();

  // The probe row carries the allow chip and the abbreviated doc subject.
  await expect(deleteRow.locator(".status-tag")).toHaveText("allow");
  await expect(deleteRow).toContainText("doc ");
  await expect(deleteRow).toContainText("user ");

  // The cursor affordance is unconditional (see header); one click
  // appends the next page.
  await page.getByRole("button", { name: "Load more" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(25);

  await expectNoAxeViolations(page);
});

test("audit.get: a trail row opens the full forensic record; deep links survive reload; bad ids land on notFound", async ({
  page,
}) => {
  await signIn(page);
  const probeId = await mintProbeEvents(page, "Trail probe deep");

  await page.goto("/audit");
  // Newest-first: the first doc.delete link is this test's probe. (The
  // delete record, not the create: doc.create's audit subject carries no
  // id — `subjectFrom` runs before the id is minted — while doc.delete's
  // subject IS the doc id, which is what pins the record to this test.)
  await page.getByRole("link", { name: "doc.delete" }).first().click();
  await expect(page).toHaveURL(/\/audit\/[0-9a-f-]{36}$/);

  // The record: header = capability id + outcome chip; `.kv` facts carry
  // the full unabbreviated ids — the probe doc id pins the row to THIS
  // test's mutation, not merely any doc.delete.
  await expect(page.locator("h2.t")).toHaveText("doc.delete");
  await expect(page.locator(".ph .status-tag")).toHaveText("allow");
  const facts = page.locator(".kv");
  await expect(facts.filter({ hasText: "subject" }).locator(".v")).toContainText(probeId);
  await expect(facts.filter({ hasText: "principal" }).locator(".v")).toContainText("user");
  await expect(facts.filter({ hasText: "when (utc)" }).locator(".v")).toHaveText(
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
  );
  await expect(facts.filter({ hasText: "category" }).locator(".v")).toHaveText("mutation");
  // The open-shaped effect renders verbatim as JSON.
  await expect(page.locator("pre")).toContainText('"kind"');
  await expectNoAxeViolations(page);

  // Deep link: a fresh load (loader → audit.get) renders the same record.
  await page.reload();
  await expect(page.locator("h2.t")).toHaveText("doc.delete");

  // notFound arms: a well-formed UUIDv7 that addresses nothing (wire
  // 404) and a malformed id the wire rejects as 400 — same honest
  // answer for the person holding the link.
  await page.goto("/audit/01900000-0000-7000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "No such audit event" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.goto("/audit/not-a-uuid");
  await expect(page.getByRole("heading", { name: "No such audit event" })).toBeVisible();
  await page.getByRole("link", { name: "Back to the trail." }).click();
  await expect(page).toHaveURL(/\/audit$/);
});
