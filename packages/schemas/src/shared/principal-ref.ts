/**
 * Principal reference — INTERNAL composition shape only (ADR 0040, H12).
 *
 * **Never make this a capability-input field.** Capability inputs use
 * flat sibling fields `subject_kind` / `subject_id` at the top level
 * (the shipped `workspace.member_add` exemplar). A nested object field
 * does NOT trip the CLI/MCP generators' top-level-ZodObject guard, so a
 * `subject: PrincipalRefSchema` input would generate a broken
 * `--subject` CLI flag and a misleading MCP argument *silently* — the
 * build stays green while two surfaces ship unusable. A richer input
 * shape is an explicit ADR 0034 revisit, not a quiet exception here.
 *
 * What this IS for: handler-internal plumbing — resolver lookups, audit
 * helpers, dispatcher composition — anywhere a `{ kind, id }` pair
 * travels *inside* the server after the flat wire fields are parsed.
 *
 * `id` stays an unbranded non-empty string because the brand depends on
 * `kind` (`UserId` is Better-Auth-owned and may be v4; `AgentId` is
 * product-owned v7) — callers narrow per-kind at the point they know
 * which constructor applies.
 */

import { PRINCIPAL_KINDS } from "@editorzero/scopes";
import { z } from "zod";

export const PrincipalRefSchema = z
  .object({
    kind: z.enum(PRINCIPAL_KINDS),
    id: z.string().min(1, "must not be empty"),
  })
  .strict();

export type PrincipalRef = z.infer<typeof PrincipalRefSchema>;
