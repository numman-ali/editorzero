/**
 * Branded IDs (architecture.md §16.3).
 *
 * Handlers accept branded IDs, not `string`. Passing the wrong ID is a
 * compile error. Parsers are the single entry point per type; format
 * validation (UUIDv7) lives here and only here.
 */

export type Branded<T, B> = T & { readonly __brand: B };

export type WorkspaceId = Branded<string, "WorkspaceId">;
export type UserId = Branded<string, "UserId">;
export type AgentId = Branded<string, "AgentId">;
export type DocId = Branded<string, "DocId">;
export type BlockId = Branded<string, "BlockId">;
export type CollectionId = Branded<string, "CollectionId">;
// ADR 0040 (Space/Grant tenancy model). `TeamId` lands with the Teams
// slice; there is deliberately no `OrgId` — multi-org is a product
// non-goal (ADR 0040 Step 9).
export type SpaceId = Branded<string, "SpaceId">;
export type GrantId = Branded<string, "GrantId">;
export type CapabilityId = Branded<string, "CapabilityId">;
export type SessionId = Branded<string, "SessionId">;
export type TokenId = Branded<string, "TokenId">;
export type JobId = Branded<string, "JobId">;
export type MirrorId = Branded<string, "MirrorId">;
export type CustomDomainId = Branded<string, "CustomDomainId">;
export type CommentId = Branded<string, "CommentId">;
export type AttachmentId = Branded<string, "AttachmentId">;
export type UploadId = Branded<string, "UploadId">;
export type VersionId = Branded<string, "VersionId">;
export type WebhookId = Branded<string, "WebhookId">;

/**
 * Validates UUIDv7-shaped hex strings (with or without hyphens) and casts
 * to the brand. Callers that synthesize IDs via `crypto.randomUUID()` on a
 * v7-capable runtime can pass the result directly.
 *
 * Not-v7 shapes throw; accept UUIDv4 from Better Auth via `unsafeParseId`
 * below so we don't crash on Better-Auth-owned rows.
 */
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const UUIDV7_VERSION_NIBBLE = "7";

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new TypeError(`invalid UUID: ${value}`);
  }
}

function isUuidV7(value: string): boolean {
  const undashed = value.replace(/-/g, "");
  return undashed.length === 32 && undashed[12] === UUIDV7_VERSION_NIBBLE;
}

function parseV7<B extends string>(brand: B, value: string): Branded<string, B> {
  assertUuid(value);
  if (!isUuidV7(value)) {
    throw new TypeError(`expected UUIDv7 for ${brand}, got non-v7: ${value}`);
  }
  return value as Branded<string, B>;
}

function parseAny<B extends string>(_brand: B, value: string): Branded<string, B> {
  assertUuid(value);
  return value as Branded<string, B>;
}

// Product-owned IDs are all UUIDv7 (time-sortable; architecture.md §3.1).
export const WorkspaceId = (s: string): WorkspaceId => parseV7("WorkspaceId", s);
export const AgentId = (s: string): AgentId => parseV7("AgentId", s);
export const DocId = (s: string): DocId => parseV7("DocId", s);
export const BlockId = (s: string): BlockId => parseV7("BlockId", s);
export const CollectionId = (s: string): CollectionId => parseV7("CollectionId", s);
export const SpaceId = (s: string): SpaceId => parseV7("SpaceId", s);
export const GrantId = (s: string): GrantId => parseV7("GrantId", s);
export const CommentId = (s: string): CommentId => parseV7("CommentId", s);
export const AttachmentId = (s: string): AttachmentId => parseV7("AttachmentId", s);
export const UploadId = (s: string): UploadId => parseV7("UploadId", s);
export const VersionId = (s: string): VersionId => parseV7("VersionId", s);
export const MirrorId = (s: string): MirrorId => parseV7("MirrorId", s);
export const CustomDomainId = (s: string): CustomDomainId => parseV7("CustomDomainId", s);
export const WebhookId = (s: string): WebhookId => parseV7("WebhookId", s);

// Better-Auth-owned IDs (§3.3 — we join but don't write) may be UUIDv4.
export const UserId = (s: string): UserId => parseAny("UserId", s);
export const SessionId = (s: string): SessionId => parseAny("SessionId", s);
export const TokenId = (s: string): TokenId => parseAny("TokenId", s);

// CapabilityId is a dot-separated identifier, not a UUID.
const CAPABILITY_ID_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const CapabilityId = (s: string): CapabilityId => {
  if (!CAPABILITY_ID_RE.test(s)) {
    throw new TypeError(`invalid CapabilityId: ${s}`);
  }
  return s as CapabilityId;
};

// JobId format is driver-specific; no runtime assertion.
export const JobId = (s: string): JobId => s as JobId;

// ── UUIDv7 generator ──────────────────────────────────────────────────────
//
// Node 22's `crypto.randomUUID()` returns UUIDv4 (random); product-owned
// IDs require v7 (time-sortable, architecture.md §3.1) so list / paginate /
// index paths can rely on creation-time monotonicity. RFC 9562 §5.7
// defines the layout:
//
//   48 bits Unix ms timestamp
//    4 bits version (= 0b0111)
//   12 bits rand_a           (this impl: monotonic counter — see below)
//    2 bits variant (= 0b10)
//   62 bits rand_b           (random)
//
// Hex form (32 chars, 5 dash-separated groups):
//   TTTTTTTT-TTTT-7ccc-Vxxx-xxxxxxxxxxxx
//     where T = ts nibble, 7 = version, c = counter nibble,
//     V ∈ {8,9,A,B} = variant + 2 rand bits.
//
// **Monotonicity within a ms — RFC 9562 §6.2 Method 1 (Fixed-Length
// Dedicated Counter).** A naive v7 leaves `rand_a` + `rand_b` fully
// random, so two IDs minted at the same `Date.now()` tick may sort
// arbitrarily. That breaks any consumer using UUIDv7 as a list
// `order_key` (e.g., `docs.order_key`): burst creates would sort
// non-deterministically, which Codex flagged as a real user-visible
// bug. We close that by encoding a 12-bit counter into `rand_a` that
// increments for each call within the same ms and reseeds (random
// start in the lower half — 11 bits of headroom) on a new ms tick.
// Counter overflow within a single ms (> 4096 calls) advances the
// timestamp by 1 ms to preserve the monotonicity invariant; the
// next real `Date.now()` tick catches up automatically.
//
// The 62-bit `rand_b` stays fully random, so two processes minting
// IDs in the same ms still produce distinct values with
// 2^62-indistinguishable probability (the counter is per-process, not
// global). Cross-process ordering inside a ms is not claimed;
// intra-process burst monotonicity is.

const SUB_MS_COUNTER_MAX = 0xfff; // 12 bits fit in rand_a

let lastTs = 0;
let subMsCounter = 0;

/**
 * Test-only hook: reset the module-level monotonic counter state.
 * Tests that compare timestamps across fake clocks call this to
 * avoid "counter drift from an earlier test" interfering with their
 * assertions. Production callers never invoke it.
 */
export function __resetUuidV7StateForTesting(): void {
  lastTs = 0;
  subMsCounter = 0;
}

export function uuidV7(): string {
  let ts = Date.now();

  if (ts > lastTs) {
    lastTs = ts;
    // New ms: reseed counter in the lower half to leave headroom for
    // the expected burst size before overflow. A fully-random start
    // (0..0xfff) would give us an average of 2048 monotonic slots
    // per ms; a lower-half start (0..0x7ff) gives us a minimum of
    // 2048 monotonic slots before overflow, which is plenty for
    // realistic workloads and simpler to reason about.
    const seed = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
    subMsCounter = seed & 0x7ff;
  } else {
    // Same ms, or a clock reverse (NTP slew): stay on lastTs and bump.
    ts = lastTs;
    subMsCounter = (subMsCounter + 1) & SUB_MS_COUNTER_MAX;
    if (subMsCounter === 0) {
      // Counter wrapped: carry into the next logical ms. A real
      // `Date.now()` past `lastTs + 1` will re-seed next call.
      lastTs += 1;
      ts = lastTs;
    }
  }

  const tsHex = ts.toString(16).padStart(12, "0").slice(-12);
  const counterHex = subMsCounter.toString(16).padStart(3, "0");

  // rand_b: 62 bits random (8 bytes). First byte's top two bits carry
  // the RFC variant (0b10).
  const rand = crypto.getRandomValues(new Uint8Array(8));
  rand[0] = ((rand[0] ?? 0) & 0x3f) | 0x80;

  let randHex = "";
  for (const byte of rand) {
    randHex += byte.toString(16).padStart(2, "0");
  }

  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${counterHex}-${randHex.slice(0, 4)}-${randHex.slice(4, 16)}`;
}

export const generateDocId = (): DocId => DocId(uuidV7());
export const generateWorkspaceId = (): WorkspaceId => WorkspaceId(uuidV7());
export const generateCollectionId = (): CollectionId => CollectionId(uuidV7());
export const generateSpaceId = (): SpaceId => SpaceId(uuidV7());
export const generateGrantId = (): GrantId => GrantId(uuidV7());
export const generateBlockId = (): BlockId => BlockId(uuidV7());
export const generateAgentId = (): AgentId => AgentId(uuidV7());
export const generateCommentId = (): CommentId => CommentId(uuidV7());
export const generateAttachmentId = (): AttachmentId => AttachmentId(uuidV7());
export const generateUploadId = (): UploadId => UploadId(uuidV7());
export const generateVersionId = (): VersionId => VersionId(uuidV7());
export const generateMirrorId = (): MirrorId => MirrorId(uuidV7());
export const generateCustomDomainId = (): CustomDomainId => CustomDomainId(uuidV7());
export const generateWebhookId = (): WebhookId => WebhookId(uuidV7());
