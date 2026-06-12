import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: collection.list
 * proves-capability-cell: collection.create
 *
 * The `collection.list` + `collection.create` × Web UI parity cells
 * (invariant 4, ADR 0033 §3 / 0040 H11): the sidebar Collections tree,
 * rendered on every authed screen by the `_authed` layout, and the
 * section header's "+" disclosure that creates into it. The marker
 * lines above are load-bearing — `packages/contract-tests` binds each
 * capability's `"ui"` declaration to this spec.
 *
 * The wire is a FLAT `order_key`-ordered array; the nesting is the
 * client's `flattenCollectionTree` (unit-tested in apps/app). This spec
 * proves the binding end-to-end: the section is honestly ABSENT on an
 * empty workspace, then collections created over the same HTTP API the
 * other surfaces use render as a nested tree in DFS order.
 *
 * Runs alphabetically BEFORE docs.spec.ts — that file's empty-state
 * assertion is about DOCS, which this spec never creates.
 */
test.describe.configure({ mode: "serial" });

/** API sign-in via the page's own request context (the docs.spec pattern). */
async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

test("an empty workspace renders the create affordance but no tree", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  // The tree <nav> is honestly absent (the rows ARE the navigation),
  // but the section header + "+" trigger render — with a create cell,
  // an empty workspace is a starting point, not a dead section.
  await expect(page.getByRole("navigation", { name: "Collections" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New collection" })).toBeVisible();
});

test("collections created over the API render as a nested tree in DFS order", async ({ page }) => {
  await signIn(page);
  // Create through the same capability surface (POST /collections/create)
  // the API/CLI/MCP cells use — root, child under it, second root.
  const rootRes = await page.request.post("/collections/create", {
    data: { title: "Field Guides" },
  });
  expect(rootRes.ok()).toBe(true);
  // The create echo's id field is `collection_id` (the LIST summary calls
  // it `id`) — reading the wrong one here silently mints a root: the
  // undefined parent_id serializes away and the create still 200s.
  const root: { collection_id?: string } = await rootRes.json();
  expect(root.collection_id).toBeDefined();
  const childRes = await page.request.post("/collections/create", {
    data: { title: "Sub Guides", parent_id: root.collection_id },
  });
  expect(childRes.ok()).toBe(true);
  const archiveRes = await page.request.post("/collections/create", {
    data: { title: "Archive" },
  });
  expect(archiveRes.ok()).toBe(true);

  await page.goto("/");
  const tree = page.getByRole("navigation", { name: "Collections" });
  const rows = tree.locator(".row");
  // DFS order: the child follows its parent, the second root closes.
  await expect(rows).toHaveText([/Field Guides/, /Sub Guides/, /Archive/]);
  // The child is indented one token-sheet level; the parent carries the
  // has-children caret, the leaf rows do not.
  await expect(rows.nth(1)).toHaveClass("row ind");
  await expect(rows.nth(0).locator(".tw")).toBeVisible();
  await expect(rows.nth(1).locator(".tw")).toHaveCount(0);
  await expect(rows.nth(2).locator(".tw")).toHaveCount(0);

  await expectNoAxeViolations(page);
});

test("collection.create: the sidebar disclosure creates a root collection into the tree", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");

  // Trigger morphs into the inline form; focus lands in the input.
  await page.getByRole("button", { name: "New collection" }).click();
  const input = page.getByRole("textbox", { name: "Collection title" });
  await expect(input).toBeFocused();
  await input.fill("Receipts");
  await expectNoAxeViolations(page); // the open form is part of the audited surface
  await page.getByRole("button", { name: "Create" }).click();

  // The invalidation re-renders the tree with the new root LAST (wire
  // order is order_key = creation order); the form closes back to the
  // trigger.
  const rows = page.getByRole("navigation", { name: "Collections" }).locator(".row");
  await expect(rows).toHaveText([/Field Guides/, /Sub Guides/, /Archive/, /Receipts/]);
  await expect(page.getByRole("button", { name: "New collection" })).toBeVisible();

  // Server-state proof: a full reload renders the same tree — the row
  // exists in the DB, not in client cache.
  await page.reload();
  await expect(rows).toHaveText([/Field Guides/, /Sub Guides/, /Archive/, /Receipts/]);

  // The 409 sibling-slug arm: an existing root title refuses with the
  // typed alert and the form stays open for a different title.
  await page.getByRole("button", { name: "New collection" }).click();
  await page.getByRole("textbox", { name: "Collection title" }).fill("Field Guides");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expect(rows).toHaveCount(4);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "New collection" })).toBeVisible();
});
