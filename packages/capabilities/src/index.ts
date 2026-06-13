/**
 * Capability kernel — public barrel (architecture.md §4, §16.4).
 */

export { createDefaultRegistry } from "./default-registry";
export type { HttpBinding } from "./http-binding";
export { deriveHttpBinding, expandPathTemplate } from "./http-binding";
export type {
  AgentAllowance,
  AnyCapability,
  Capability,
  CapabilityAudit,
  CapabilityContext,
  Deprecation,
  Logger,
  RateLimit,
  Tracer,
  TracerSpan,
} from "./kernel";
export type { Registry } from "./registry";
export { createRegistry, RegistryLookupError, registerCapability } from "./registry";

// ── ACL ceiling resolver (ADR 0040 Step 6) ─────────────────────────────────
//
// Not a capability — the handler-side read authority (F88 deny channel).
// Exported for the prop-lane fuzzer and for any future surface-adjacent
// consumer that must reason about read sets (never to re-implement them).

export type { CeilingDocRow, DocReadResolver, Placement } from "./acl/ceiling";
export { loadDocReadResolver } from "./acl/ceiling";

// ── Capabilities (registered into `createRegistry` by a consumer) ─────────
//
// Capabilities export the `Capability<I, O>` value. Registration into a
// registry (which closes over their typed I/O) is the consumer's job —
// typically a central `registerAll()` in an app adapter. This keeps this
// barrel dependency-light and lets consumers choose which capabilities
// to include (e.g., an admin-only surface that omits public ones).

export { agentCreate } from "./agent/create";
export { agentGet } from "./agent/get";
export { agentList } from "./agent/list";
export { agentRevoke } from "./agent/revoke";
export { parseStoredScopes } from "./agent/stored-scopes";
export { agentTokenList } from "./agent/token_list";
export { agentTokenMint } from "./agent/token_mint";
export { agentTokenRevoke } from "./agent/token_revoke";
export {
  AGENT_TOKEN_PREFIX,
  hashAgentToken,
  isWellFormedAgentToken,
  type MintedAgentToken,
  mintAgentToken,
} from "./agent/token-crypto";
export { agentUpdate } from "./agent/update";
export { auditGet } from "./audit/get";
export { auditList } from "./audit/list";
export { collectionCreate } from "./collection/create";
export { collectionDelete } from "./collection/delete";
export { collectionList } from "./collection/list";
export { collectionMove } from "./collection/move";
export { collectionRestore } from "./collection/restore";
export { collectionUpdate } from "./collection/update";
export { docAddGuest } from "./doc/add_guest";
export { docApplyUpdate } from "./doc/apply_update";
export { docCreate } from "./doc/create";
export { docDelete } from "./doc/delete";
export { docGet } from "./doc/get";
export { docList } from "./doc/list";
export { docMove } from "./doc/move";
export { docPublish } from "./doc/publish";
export { docRemoveGuest } from "./doc/remove_guest";
export { docRename } from "./doc/rename";
export { docRestore } from "./doc/restore";
export { docUnpublish } from "./doc/unpublish";
export { docUpdate } from "./doc/update";
export { permissionGrant } from "./permission/grant";
export { permissionList } from "./permission/list";
export { permissionRevoke } from "./permission/revoke";
export { spaceArchive } from "./space/archive";
export { spaceCreate } from "./space/create";
export { spaceGet } from "./space/get";
export { spaceList } from "./space/list";
export { spaceMemberAdd } from "./space/member_add";
export { spaceMemberRemove } from "./space/member_remove";
export { spaceMemberUpdateRole } from "./space/member_update_role";
export { spaceRestore } from "./space/restore";
export { spaceUpdate } from "./space/update";
export { workspaceGet } from "./workspace/get";
export { workspaceMemberAdd } from "./workspace/member_add";
export { workspaceMemberList } from "./workspace/member_list";
export { workspaceMemberRemove } from "./workspace/member_remove";
export { workspaceMemberUpdateRole } from "./workspace/member_update_role";
export { workspaceUpdate } from "./workspace/update";
