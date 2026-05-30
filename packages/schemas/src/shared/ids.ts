/**
 * Shared branded-ID field schemas — the single source for how an ID is
 * validated on the wire and narrowed to its brand (ADR 0034).
 *
 * **Naming (ADR 0034).** Every schema VALUE is PascalCase + `Schema`
 * suffix (`DocIdInputSchema`); inferred TYPES are PascalCase with no
 * suffix (the brand `DocId` already comes from `@editorzero/ids`). The
 * `Schema` suffix is what distinguishes the zod value from the type it
 * produces — necessary here because a transform-bearing schema has two
 * distinct types (`z.input` ≠ `z.output`), so value and type cannot share
 * one name.
 *
 * Two flavours per ID, because the two directions have different jobs:
 *
 *  - **`*InputSchema`** — for request fields a caller supplies. Product
 *    IDs validate the UUIDv7 shape (`z.uuid({ version: "v7" })`) so the
 *    generated OpenAPI request body carries the format/pattern and a
 *    malformed value is a clean 400, then `.transform()` narrows to the
 *    brand (so `c.req.valid()` is branded). Better-Auth-owned IDs
 *    (`UserId`) may be UUIDv4, so they validate as a non-empty string
 *    only — matching `@editorzero/ids`'s `parseAny` constructor.
 *
 *  - **`*OutputSchema`** — for response fields the server produces. No
 *    format validation (the value already came from trusted internal
 *    state); `z.string().transform()` narrows to the brand. On the wire
 *    / in the generated OpenAPI this is a plain `string`; for in-process
 *    `hc` consumers it is the brand (ADR 0033 — branded responses are a
 *    feature for the typed Web UI, transparent to external clients).
 *
 * Generic UUIDv7 message ("must be a UUIDv7") — the zod issue `path`
 * identifies the offending field, so one shared schema serves `doc_id`,
 * `parent_id`, `new_parent_id`… without a per-field message string.
 *
 * Compose nullability/optionality at the use site:
 * `CollectionIdInputSchema.nullable().optional()`,
 * `CollectionIdOutputSchema.nullable()`.
 *
 * **ADR 0034 constraint:** these are *wire-preserving* transforms
 * (string → branded string). A field that maps JSON to a non-JSON
 * runtime type (Date, URL, class) may NOT be a shared API schema — that
 * route needs explicit wire/internal separation.
 */

import {
  AgentId,
  BlockId,
  CollectionId,
  DocId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { z } from "zod";

// ── Product IDs (UUIDv7 — time-sortable, architecture.md §3.1) ─────────────

export const DocIdInputSchema = z
  .uuid({ version: "v7", message: "must be a UUIDv7" })
  .transform((s): DocId => DocId(s));
export const DocIdOutputSchema = z.string().transform((s): DocId => DocId(s));

export const CollectionIdInputSchema = z
  .uuid({ version: "v7", message: "must be a UUIDv7" })
  .transform((s): CollectionId => CollectionId(s));
export const CollectionIdOutputSchema = z.string().transform((s): CollectionId => CollectionId(s));

export const WorkspaceIdInputSchema = z
  .uuid({ version: "v7", message: "must be a UUIDv7" })
  .transform((s): WorkspaceId => WorkspaceId(s));
export const WorkspaceIdOutputSchema = z.string().transform((s): WorkspaceId => WorkspaceId(s));

export const BlockIdInputSchema = z
  .uuid({ version: "v7", message: "must be a UUIDv7" })
  .transform((s): BlockId => BlockId(s));
export const BlockIdOutputSchema = z.string().transform((s): BlockId => BlockId(s));

export const AgentIdInputSchema = z
  .uuid({ version: "v7", message: "must be a UUIDv7" })
  .transform((s): AgentId => AgentId(s));
export const AgentIdOutputSchema = z.string().transform((s): AgentId => AgentId(s));

// ── Better-Auth-owned IDs (may be UUIDv4; §3.3) ────────────────────────────

// Input keeps the value a plain string (matches the existing member-op
// contract: handlers brand it themselves). Not branded-on-input because
// `UserId()` would throw a raw TypeError (→ 500) on a malformed value
// rather than a typed 400; preserving the current behaviour is a
// migration-faithfulness choice, not an endorsement.
export const UserIdInputSchema = z.string().min(1, "must not be empty");
export const UserIdOutputSchema = z.string().transform((s): UserId => UserId(s));

export const TokenIdOutputSchema = z.string().transform((s): TokenId => TokenId(s));
