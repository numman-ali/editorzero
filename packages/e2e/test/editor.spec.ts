import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: doc.get
 * proves-capability-cell: doc.update
 * proves-capability-cell: doc.rename
 * proves-capability-cell: doc.delete
 * proves-capability-cell: doc.publish
 * proves-capability-cell: doc.unpublish
 * proves-capability-cell: doc.move
 *
 * The HTTP-first editor cells (ADR 0038; invariant 4, ADR 0033 §3 / 0040
 * H11). Seven markers, one screen: `/doc/$docId` loads a doc through
 * `doc.get` (loader + owned-model parse + Tiptap render), persists
 * edits through `doc.update` (browser diff → ops batch with per-block
 * hash preconditions → explicit Save), renames through the toolbar's
 * `doc.rename` control (title-slot rule: row title + slug + the canvas
 * heading move together in one audited mutation — distinct from editing
 * the heading block, which is a content op), and soft-deletes through
 * the toolbar's `doc.delete` Trash control (recoverable per invariant
 * 6 — the spec restores over the API, the browser Trash screen being a
 * later cell).
 *
 * The proof is end-to-end against real server state: the doc is created
 * over the same `POST /docs/create` every surface uses, the editor is
 * reached by clicking the doc.list row link, the edit travels as real
 * `insert`/`update` ops, and the reload assertion can only pass if the
 * server actually persisted them — a screen that faked its save would
 * fail there.
 */
test.describe.configure({ mode: "serial" });

const DOC_TITLE = "Editor proving ground";
const EDITED_LINE = "Written from the browser editor.";
const INSERTED_LINE = "Second block, minted on save.";
const RENAMED_TITLE = "Editor proving ground, renamed";

async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

test("doc.get: the list row links to /doc/$docId and the editor renders the seeded blocks", async ({
  page,
}) => {
  await signIn(page);
  const res = await page.request.post("/docs/create", { data: { title: DOC_TITLE } });
  expect(res.ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("link", { name: DOC_TITLE }).click();
  await expect(page).toHaveURL(/\/doc\/[0-9a-f-]+$/);

  // Panel header carries the docs-row title (read-only until the
  // doc.rename cell); the editor surface renders the seeded content —
  // heading-1 title block + trailing empty paragraph — from doc.get.
  await expect(page.locator("h2.t")).toHaveText(DOC_TITLE);
  const surface = page.locator(".doc-editor-surface");
  await expect(surface).toHaveAttribute("contenteditable", "true");
  await expect(surface.locator("h1")).toHaveText(DOC_TITLE);
  await expect(surface.locator("p")).toHaveCount(1);

  await expectNoAxeViolations(page);
});

test("doc.update: typed edits save as ops and survive a full reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: DOC_TITLE }).click();

  const surface = page.locator(".doc-editor-surface");
  await expect(surface.locator("h1")).toHaveText(DOC_TITLE);

  // Type into the seeded empty paragraph (a content `update` op with a
  // hash precondition), then Enter + a second line (an `insert` op whose
  // id the server mints) — both op kinds round-trip in one Save.
  await surface.locator("p").last().click();
  await page.keyboard.type(EDITED_LINE);
  await page.keyboard.press("Enter");
  await page.keyboard.type(INSERTED_LINE);
  await expect(page.getByRole("status")).toHaveText("Unsaved changes");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  // The post-save re-base must keep the typed content on the canvas —
  // a `fetchQuery` that serves the route loader's cached (pre-save)
  // snapshot would pass the status assertion above yet wipe both
  // lines here (caught live in the 2026-06-12 visual smoke; the
  // re-base now forces `staleTime: 0`).
  await expect(surface.locator("p").nth(0)).toHaveText(EDITED_LINE);
  await expect(surface.locator("p").nth(1)).toHaveText(INSERTED_LINE);

  // The reload can only render this from the server's Y.Doc — the
  // editor state above is gone with the page.
  await page.reload();
  await expect(surface.locator("h1")).toHaveText(DOC_TITLE);
  await expect(surface.locator("p").nth(0)).toHaveText(EDITED_LINE);
  await expect(surface.locator("p").nth(1)).toHaveText(INSERTED_LINE);

  await expectNoAxeViolations(page);
});

test("doc.rename: the toolbar control renames row title, slug, and canvas heading together (doc.rename cell)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: DOC_TITLE }).click();

  // The trigger morphs into the inline form, prefilled with the current
  // title; focus lands in the input.
  await page.getByRole("button", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "Doc title" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(DOC_TITLE);
  await input.fill(RENAMED_TITLE);
  await expectNoAxeViolations(page); // the open form is part of the audited surface
  await page.getByRole("button", { name: "Apply" }).click();

  // One mutation, three visible effects: the panel header (doc.get
  // cache rewritten by the re-base), the slug ("slug tracks title" in
  // v1), and the CANVAS heading (the capability's title-slot bridge
  // rewrote the Y.Doc block server-side — only the re-base can show it).
  await expect(page.locator("h2.t")).toHaveText(RENAMED_TITLE);
  await expect(page.locator(".pth")).toHaveText("editor-proving-ground-renamed");
  await expect(page.locator(".doc-editor-surface h1")).toHaveText(RENAMED_TITLE);
  // The content blocks rode through the rename untouched.
  await expect(page.locator(".doc-editor-surface p").nth(0)).toHaveText(EDITED_LINE);

  // Server-state proof: the list row shows the new title + slug.
  await page.goto("/");
  await expect(page.getByRole("cell").filter({ hasText: RENAMED_TITLE })).toBeVisible();
  await expect(page.getByText("editor-proving-ground-renamed", { exact: true })).toBeVisible();
});

test("doc.rename: duplicate title surfaces the typed 409; a dirty canvas gates the control", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: RENAMED_TITLE }).click();

  // "Launch checklist" exists at the workspace root (docs.spec.ts runs
  // first) — renaming onto its slug must refuse with the typed 409 and
  // keep the form open for a different title.
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Doc title" }).fill("Launch checklist");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expect(page.locator("h2.t")).toHaveText(RENAMED_TITLE);
  await page.getByRole("button", { name: "Cancel" }).click();

  // Dirty canvas disables the trigger: the post-rename re-base replaces
  // canvas content, so renaming mid-edit would discard unsaved work.
  await page.locator(".doc-editor-surface p").last().click();
  await page.keyboard.type("dirty");
  await expect(page.getByRole("status")).toHaveText("Unsaved changes");
  await expect(page.getByRole("button", { name: "Rename" })).toBeDisabled();
});

test("doc.delete: the toolbar Trash control soft-deletes, returns to the list, and stays recoverable (doc.delete cell)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: RENAMED_TITLE }).click();
  await page.waitForURL(/\/doc\/[0-9a-f-]{36}$/u);
  const docId = new URL(page.url()).pathname.split("/").at(-1);

  // Trigger → inline confirm (the disclosure pattern); confirm trashes
  // and navigates home. No dirty gate — trashing discards edits by
  // intent; the confirm step is the guard.
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expectNoAxeViolations(page); // the open confirm row is part of the audited surface
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page.waitForURL((url) => url.pathname === "/");

  // Server state: doc.list excludes trashed — the row is gone while its
  // siblings remain.
  await expect(page.getByRole("cell").filter({ hasText: RENAMED_TITLE })).toHaveCount(0);
  await expect(page.getByRole("cell").filter({ hasText: "Launch checklist" })).toBeVisible();
  // The doc itself now 404s.
  const gone = await page.request.get(`/docs/get/${docId}`);
  expect(gone.status()).toBe(404);

  // Invariant 6: the soft-delete is recoverable via a first-class
  // capability — restore over the API (the browser Trash screen is a
  // later cell, blocked on a trash-listing capability) and the row
  // returns to the list with content intact.
  const restored = await page.request.post(`/docs/restore/${docId}`);
  expect(restored.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByRole("cell").filter({ hasText: RENAMED_TITLE })).toBeVisible();
});

test("doc.publish/doc.unpublish: the header toggle mints + clears the publish pair (publish cells)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  // Publish is orthogonal to access_mode: every chip starts unpublished.
  await expect(page.locator(".st-pub")).toHaveCount(0);

  await page.getByRole("link", { name: RENAMED_TITLE }).click();
  await page.waitForURL(/\/doc\/[0-9a-f-]{36}$/u);

  // Publish: the minted slug appears as header status (the public
  // reader route is a later slice — state + slug are the effects).
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const status = page.getByText(/^published · /u);
  await expect(status).toBeVisible();
  await expect(status).toContainText("editor-proving-ground-renamed");
  await expectNoAxeViolations(page);

  // Cross-screen server state: the list chip goes published-green.
  await page.goto("/");
  await expect(page.locator(".st-pub")).toHaveCount(1);

  // Unpublish clears the pair; the chip drops back to the base outline.
  await page.getByRole("link", { name: RENAMED_TITLE }).click();
  await page.getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expect(page.getByText(/^published · /u)).toHaveCount(0);
  await page.goto("/");
  await expect(page.locator(".st-pub")).toHaveCount(0);
});

test("doc.move: same-bucket moves need no policy; a crossing demands the explicit pole (doc.move cell)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: RENAMED_TITLE }).click();
  await page.waitForURL(/\/doc\/[0-9a-f-]{36}$/u);
  const docId = new URL(page.url()).pathname.split("/").at(-1);
  await expect(page.getByText("· root")).toBeVisible();

  // Same-bucket: root → "Field Guides" (both legacy). The sharing
  // select must NOT render — no crossing, no policy question.
  await page.getByRole("button", { name: "Move", exact: true }).click();
  const destination = page.getByRole("combobox", { name: "Destination" });
  await expect(destination).toBeFocused();
  await destination.selectOption({ label: "Field Guides" });
  await expect(page.getByRole("combobox", { name: "Sharing policy" })).toHaveCount(0);
  await page.getByRole("button", { name: "Move doc" }).click();
  await expect(page.getByText("· Field Guides")).toBeVisible();

  // Cross-boundary: a fresh team space + a collection BOUND to it
  // (created over the same HTTP API every surface uses).
  const spaceRes = await page.request.post("/spaces/create", {
    data: { name: "Mobility", space_type: "open" },
  });
  expect(spaceRes.ok()).toBe(true);
  const space: { space_id?: string } = await spaceRes.json();
  const boundRes = await page.request.post("/collections/create", {
    data: { title: "Mobility Docs", space_id: space.space_id },
  });
  expect(boundRes.ok()).toBe(true);
  const bound: { collection_id?: string } = await boundRes.json();

  await page.reload(); // pick up the new collection in the layout cache
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByRole("combobox", { name: "Destination" }).selectOption({
    label: "Mobility Docs",
  });
  // The crossing is derived CLIENT-side (legacy → space bucket): the
  // sharing select appears and the submit stays disabled until a pole
  // is chosen — the never-silent rail in chrome.
  const policy = page.getByRole("combobox", { name: "Sharing policy" });
  await expect(policy).toBeVisible();
  await expect(page.getByRole("button", { name: "Move doc" })).toBeDisabled();
  await expectNoAxeViolations(page); // the open form incl. the policy select
  await policy.selectOption({ label: "Adopt destination sharing" });
  await page.getByRole("button", { name: "Move doc" }).click();
  await expect(page.getByText("· Mobility Docs")).toBeVisible();

  // Server-state proof while space-placed: the placement survived.
  const got = await page.request.get(`/docs/get/${docId}`);
  expect(got.ok()).toBe(true);
  const body: { doc?: { collection_id?: string | null } } = await got.json();
  expect(body.doc?.collection_id).toBe(bound.collection_id);

  // Crossing BACK (space → legacy) through the other pole — then the
  // scratch space + collection leave the stage (suite hygiene: the
  // spaces spec pins exact card arrays), proving collection.delete +
  // space.archive compose with the move over the same API.
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByRole("combobox", { name: "Destination" }).selectOption({
    label: "Workspace root",
  });
  await page.getByRole("combobox", { name: "Sharing policy" }).selectOption({
    label: "Keep current sharing",
  });
  await page.getByRole("button", { name: "Move doc" }).click();
  await expect(page.getByText("· root")).toBeVisible();
  const dropCollection = await page.request.post(`/collections/delete/${bound.collection_id}`);
  expect(dropCollection.ok()).toBe(true);
  const dropSpace = await page.request.post(`/spaces/archive/${space.space_id}`);
  expect(dropSpace.ok()).toBe(true);
});
