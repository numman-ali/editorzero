/**
 * Typed secret primitives (architecture.md §16.12).
 *
 * Product code never reads `process.env` directly — the `no-process-env`
 * arch-lint rule (§16.8) enforces it. Secrets flow through this layer so
 * the source (`file | env | vault`) is typed and rotation hooks land in
 * one place. Rotation splits into two classes (F79):
 *
 * - **Startup-only** (DB connection strings, S3 endpoint, OTLP endpoint):
 *   resolved once at boot; rotation requires restart. Handlers receive
 *   these via `StartupSecretProvider`.
 *
 * - **Runtime-rotatable** (Better Auth secrets, per-workspace webhook
 *   signing keys, per-workspace mirror auth, agent-token signing keys):
 *   held behind a version-keyed cache. `admin.secret_rotate` publishes
 *   `secret_rotated:{kind}:{version}`; each node invalidates + re-resolves
 *   on next use. Handlers receive these via `RotatableSecretProvider`.
 *
 * The split means rotating a webhook signing key takes effect in seconds
 * across all nodes; changing the DB endpoint still requires an operator
 * restart.
 */

import type { MirrorId, WorkspaceId } from "@editorzero/ids";

// ── SecretRef — where a secret is sourced from ─────────────────────────────

/**
 * A reference to a secret's storage location. The provider resolves the
 * `SecretRef` into bytes on first use; the `mount` discriminator drives
 * which resolver branch runs.
 */
export type SecretRef =
  | { readonly mount: "file"; readonly path: string }
  | { readonly mount: "env"; readonly env_var: string }
  | { readonly mount: "vault"; readonly vault_path: string };

// ── Secrets — the typed inventory (§16.12) ─────────────────────────────────

/**
 * The platform-level secret inventory. Per-tenant secrets are factories
 * that close over workspace/mirror IDs — the inventory shape stays
 * static even as tenants come and go.
 */
export interface Secrets {
  /** Better Auth session + cookie signing keys (ADR 0010, 90-day rotation). */
  readonly BETTER_AUTH_SECRETS: SecretRef;
  /** Object-store credentials for attachments + S3 mirror sink. */
  readonly S3_CREDENTIALS: SecretRef;
  /** SMTP / Resend / SES credentials for transactional email. */
  readonly SMTP_CREDENTIALS: SecretRef;
  /** Bearer for OTLP ingestion endpoint (ADR 0019). */
  readonly OTLP_EXPORTER_AUTH: SecretRef;
  /** Per-workspace HMAC key for webhook delivery signatures (§3.17, F62). */
  readonly WEBHOOK_SIGNING_KEY: (workspace_id: WorkspaceId) => SecretRef;
  /** Per-mirror auth material (GitHub App / SSH / PAT / S3 keys — ADR 0020). */
  readonly MIRROR_AUTH: (workspace_id: WorkspaceId, mirror_id: MirrorId) => SecretRef;
  /** Master key that encrypts every other secret at rest. */
  readonly KMS_MASTER_KEY: SecretRef;
}

// ── Rotation classes (F79) ─────────────────────────────────────────────────

/**
 * Kinds of secrets that are startup-only: read once at boot, cached
 * behind an interface, rotation requires restart.
 */
export type StartupSecretKind =
  | "DB_CONNECTION"
  | "REDIS_URL"
  | "S3_ENDPOINT"
  | "OTLP_ENDPOINT"
  | "KMS_MASTER_KEY"
  | "CADDY_ADMIN_ENDPOINT";

/**
 * Kinds of secrets that support live rotation via `admin.secret_rotate`
 * (§16.12). Each carries a numeric `version`; the dual-accept window
 * bridges `N-1` and `N` while sessions signed under the old version are
 * invalidated via the revocation cascade (§10.3).
 */
export type RotatableSecretKind =
  | "BETTER_AUTH_SECRETS"
  | "WEBHOOK_SIGNING_KEY" // per-workspace
  | "MIRROR_AUTH" // per-(workspace, mirror)
  | "AGENT_TOKEN_SIGNING_KEY"
  | "DIAGNOSTIC_SALT"; // per-workspace, F64

// ── Provider contracts ─────────────────────────────────────────────────────

/**
 * Read a startup-only secret. Implementations cache the resolved value;
 * callers treat the returned bytes as stable for the process lifetime.
 * Rotation of a startup-only secret requires an operator-driven restart.
 */
export interface StartupSecretProvider {
  /** Resolve and return the raw secret bytes. Cached after first call. */
  readonly get: (kind: StartupSecretKind) => Promise<Uint8Array>;
  /** UTF-8 convenience for text secrets (connection strings, endpoints). */
  readonly getString: (kind: StartupSecretKind) => Promise<string>;
}

/**
 * A versioned secret — a runtime-rotatable secret's current value plus
 * the version it was signed/issued under. Verify-with-both during a
 * dual-accept window: the verifier tries `current` first, then falls
 * back to `previous` if present.
 */
export interface VersionedSecret {
  readonly version: number;
  readonly bytes: Uint8Array;
}

export interface RotatableSecretHandle {
  /** Current version for signing / issuance. */
  readonly current: VersionedSecret;
  /** Previous version, accepted for verification during the dual-accept window. */
  readonly previous?: VersionedSecret;
  /** Unix-ms when the `previous` version is retired; undefined if no window active. */
  readonly dual_accept_until?: number;
}

/**
 * Resolves runtime-rotatable secrets. Implementations maintain an
 * in-memory cache keyed by `(kind, ...scoping)` invalidated on
 * `secret_rotated:{kind}:{version}` pub/sub events.
 */
export interface RotatableSecretProvider {
  readonly getBetterAuthSecrets: () => Promise<RotatableSecretHandle>;
  readonly getWebhookSigningKey: (workspace_id: WorkspaceId) => Promise<RotatableSecretHandle>;
  readonly getMirrorAuth: (
    workspace_id: WorkspaceId,
    mirror_id: MirrorId,
  ) => Promise<RotatableSecretHandle>;
  readonly getAgentTokenSigningKey: () => Promise<RotatableSecretHandle>;
  readonly getDiagnosticSalt: (workspace_id: WorkspaceId) => Promise<RotatableSecretHandle>;

  /**
   * Invalidate the cached handle for `kind` (and optional scoping). Called
   * by the pub/sub subscriber on `secret_rotated:{kind}:{version}` events
   * (§16.12). The next `getX(...)` call re-resolves.
   */
  readonly invalidate: (kind: RotatableSecretKind, scope?: SecretScope) => void;
}

/** Optional scoping for per-tenant rotatable secrets. */
export interface SecretScope {
  readonly workspace_id?: WorkspaceId;
  readonly mirror_id?: MirrorId;
}
