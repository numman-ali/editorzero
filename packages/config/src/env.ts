/**
 * Startup-only runtime configuration derived from the process environment.
 *
 * Product code never reads `process.env` directly (arch-lint rule
 * `no-process-env` — §16.8). Instead, `loadEnvConfig` parses + validates
 * at boot and hands the rest of the system a typed value object. Any
 * further config access goes through `RuntimeConfig` or the secret
 * providers (`./secrets`).
 *
 * Unknown keys are ignored; a schema mismatch on a known key is a hard
 * boot failure — operators discover misconfiguration at `pnpm dev` / CI,
 * not at first request.
 */

import { z } from "zod";

// ── Schema — single source of truth ────────────────────────────────────────

/**
 * The typed runtime config. Add a field once here + the matching env-var
 * row in `ENV_MAP`. `RuntimeConfig` below is `z.infer`'d — schema is the
 * one place the shape lives (§1.1: one zod schema per capability → every
 * consumer). Downstream packages import `RuntimeConfig` and receive a
 * fully-validated value.
 */
export const runtimeConfigSchema = z.object({
  /** Execution mode — drives which driver/codepath loads (ADR 0007 / 0012). */
  mode: z.enum(["single-node", "ha"]).default("single-node"),
  /** Node 22 LTS — explicitly carried so startup can refuse mismatched runtimes. */
  node_env: z.enum(["development", "test", "production"]).default("development"),
  /** Public origin the app self-identifies as (OAuth issuer, webhook signer, CORS). */
  public_origin: z.string().url(),
  /** Primary database URL. Startup-only secret; rotation requires restart. */
  database_url: z.string().min(1),
  /** Redis URL — required in `ha` mode, optional in single-node. */
  redis_url: z.string().url().optional(),
  /** OpenTelemetry OTLP endpoint for traces + metrics (ADR 0019). */
  otlp_endpoint: z.string().url().optional(),
  /** Object-store (S3-compatible) endpoint for attachments + mirror sink. */
  s3_endpoint: z.string().url().optional(),
  /** Caddy admin API endpoint (on-demand TLS coordination — ADR 0011). */
  caddy_admin_endpoint: z.string().url().optional(),
  /** Default attachment size ceiling (bytes). Per-workspace quota overrides this. */
  max_attachment_bytes: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  /** Allow SVG uploads — XSS risk via embedded script; opt-in only (§3.10a). */
  allow_svg_uploads: z.coerce.boolean().default(false),
  /** Hocuspocus per-process Y.Doc RAM cap in bytes (F38 — §10.5). */
  hocuspocus_max_ram_bytes: z.coerce.number().int().positive().optional(),
  /** Disaster-recovery mode — raises ACME re-issuance cap for 24h (F59). */
  dr_mode: z.coerce.boolean().default(false),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Env-var mapping. Keys are the snake_case fields on `RuntimeConfig`;
 * values are the env-var name(s) to read.
 */
const ENV_MAP = {
  mode: "EDITORZERO_MODE",
  node_env: "NODE_ENV",
  public_origin: "EDITORZERO_PUBLIC_ORIGIN",
  database_url: "DATABASE_URL",
  redis_url: "REDIS_URL",
  otlp_endpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
  s3_endpoint: "EDITORZERO_S3_ENDPOINT",
  caddy_admin_endpoint: "CADDY_ADMIN_ENDPOINT",
  max_attachment_bytes: "EDITORZERO_MAX_ATTACHMENT_BYTES",
  allow_svg_uploads: "ALLOW_SVG_UPLOADS",
  hocuspocus_max_ram_bytes: "EDITORZERO_HOCUSPOCUS_MAX_RAM_BYTES",
  dr_mode: "EDITORZERO_DR_MODE",
} as const satisfies Record<keyof RuntimeConfig, string>;

/**
 * Parse + validate the process environment into a `RuntimeConfig`.
 * Throws `ConfigValidationError` with the zod issue list if any known
 * key fails validation. Unknown env vars are ignored — this is not a
 * strict allowlist, only the typed surface.
 *
 * Callers that want a different source (test fixture, override) can call
 * `parseRuntimeConfig(env)` directly against any `Record<string, string>`.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return parseRuntimeConfig(env);
}

export function parseRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const raw: Record<string, string | undefined> = {};
  for (const [field, envKey] of Object.entries(ENV_MAP)) {
    const value = env[envKey];
    if (value !== undefined) raw[field] = value;
  }
  const parsed = runtimeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: ConfigIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.map((p) => (typeof p === "symbol" ? p.toString() : p)),
      message: issue.message,
    }));
    throw new ConfigValidationError(issues);
  }
  return parsed.data;
}

// ── Error type ─────────────────────────────────────────────────────────────

/**
 * Thrown when env parsing fails. Carries the full zod issue list so the
 * operator sees every misconfiguration at once, not just the first.
 */
export interface ConfigIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const summary = issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    super(`RuntimeConfig validation failed:\n${summary}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}
