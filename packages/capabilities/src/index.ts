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

// ── Capabilities (registered into `createRegistry` by a consumer) ─────────
//
// Capabilities export the `Capability<I, O>` value. Registration into a
// registry (which closes over their typed I/O) is the consumer's job —
// typically a central `registerAll()` in an app adapter. This keeps this
// barrel dependency-light and lets consumers choose which capabilities
// to include (e.g., an admin-only surface that omits public ones).

export { auditGet } from "./audit/get";
export { auditList } from "./audit/list";
export { collectionCreate } from "./collection/create";
export { collectionDelete } from "./collection/delete";
export { collectionList } from "./collection/list";
export { collectionMove } from "./collection/move";
export { collectionRestore } from "./collection/restore";
export { collectionUpdate } from "./collection/update";
export { docCreate } from "./doc/create";
export { docDelete } from "./doc/delete";
export { docGet } from "./doc/get";
export { docList } from "./doc/list";
export { docMove } from "./doc/move";
export { docPublish } from "./doc/publish";
export { docRename } from "./doc/rename";
export { docRestore } from "./doc/restore";
export { docUnpublish } from "./doc/unpublish";
export { docUpdate } from "./doc/update";
export { workspaceGet } from "./workspace/get";
export { workspaceMemberAdd } from "./workspace/member_add";
export { workspaceMemberList } from "./workspace/member_list";
export { workspaceMemberRemove } from "./workspace/member_remove";
export { workspaceMemberUpdateRole } from "./workspace/member_update_role";
export { workspaceUpdate } from "./workspace/update";
