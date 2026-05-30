/**
 * Shared scalar field schemas (ADR 0034).
 *
 * `TitleSchema` is the single definition for the human-facing title field
 * shared by `doc.create` / `doc.rename` / `collection.create` /
 * `collection.update`. The order matters: `.trim()` runs first, then
 * `.min(1)` — trimming before the length check is what closes the
 * whitespace-only hole (a value of `"   "` becomes `""` and is rejected),
 * which a bare `.min(1)` on the untrimmed string would let through.
 */

import { z } from "zod";

export const TitleSchema = z.string().trim().min(1, "title must not be empty or whitespace-only");
