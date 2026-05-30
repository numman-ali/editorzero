/**
 * Shared doc-visibility schema (ADR 0034).
 *
 * `DocVisibilitySchema` is the full tri-state used on the *read* path —
 * `doc.get` / `doc.list` echo whichever value a doc currently holds, so
 * their output schemas consume this enum directly.
 *
 * **Not** consumed by the write paths, by design:
 *  - `doc.create` accepts only a narrower subset (it cannot mint every
 *    state at creation time), so its input enum stays local to that file.
 *  - `doc.publish` / `doc.unpublish` each pin a single value via
 *    `z.literal(...)` — a literal is a tighter contract than this enum and
 *    must not be widened by sharing it.
 *
 * Keeping those write-side constraints local prevents a shared enum from
 * silently advertising states a given capability does not actually permit.
 */

import { z } from "zod";

export const DocVisibilitySchema = z.enum(["workspace", "public", "private"]);
