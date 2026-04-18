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
