import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: doc.get
 * proves-capability-cell: doc.update
 * proves-capability-cell: doc.rename
 *
 * The HTTP-first editor cells (ADR 0038; invariant 4, ADR 0033 §3 / 0040
 * H11). Three markers, one screen: `/doc/$docId` loads a doc through
 * `doc.get` (loader + owned-model parse + Tiptap render), persists
 * edits through `doc.update` (browser diff → ops batch with per-block
 * hash preconditions → explicit Save), and renames through the toolbar's
 * `doc.rename` control (title-slot rule: row title + slug + the canvas
 * heading move together in one audited mutation — distinct from editing
 * the heading block, which is a content op).
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
