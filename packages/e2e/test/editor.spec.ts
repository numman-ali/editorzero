import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: doc.get
 * proves-capability-cell: doc.update
 *
 * The HTTP-first editor cells (ADR 0038; invariant 4, ADR 0033 §3 / 0040
 * H11). Two markers, one screen: `/doc/$docId` loads a doc through
 * `doc.get` (loader + owned-model parse + Tiptap render) and persists
 * edits through `doc.update` (browser diff → ops batch with per-block
 * hash preconditions → explicit Save).
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
