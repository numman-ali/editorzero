/**
 * `createDefaultRegistry` — the canonical registry of every shipped
 * capability, in one place.
 *
 * Each surface that needs a registry (the api-server composition root via
 * `getApiApp`, the CLI subcommand generator via `cliRegistry`) builds it
 * from this single list rather than maintaining its own
 * `createRegistry([...])`. Two hand-maintained capability lists is exactly
 * the drift the "single source of truth, derived elsewhere" rule forbids:
 * a capability added to one surface's list but not the other would expose
 * unevenly and break capability-matrix parity (AGENTS.md invariant 4).
 *
 * Per-surface *exposure* differences are not expressed by registering a
 * different subset here — they are expressed by each capability's own
 * `surfaces` array, which the surface adapters filter on (e.g. the MCP
 * adapter keeps `surfaces.includes("mcp") && !humanOnly`). So the registry
 * is always the full set; filtering is downstream and declarative.
 *
 * Adding a capability: implement it under `src/<domain>/<action>.ts`,
 * export it from the barrel, then add the one `registerCapability(...)`
 * line below. Both the server and the CLI pick it up with no further
 * wiring; the contract-matrix parity test enforces that every
 * type-compatible cell has a route.
 */

import { auditGet } from "./audit/get";
import { auditList } from "./audit/list";
import { collectionCreate } from "./collection/create";
import { collectionDelete } from "./collection/delete";
import { collectionList } from "./collection/list";
import { collectionMove } from "./collection/move";
import { collectionRestore } from "./collection/restore";
import { collectionUpdate } from "./collection/update";
import { docCreate } from "./doc/create";
import { docDelete } from "./doc/delete";
import { docGet } from "./doc/get";
import { docList } from "./doc/list";
import { docMove } from "./doc/move";
import { docPublish } from "./doc/publish";
import { docRename } from "./doc/rename";
import { docRestore } from "./doc/restore";
import { docUnpublish } from "./doc/unpublish";
import { docUpdate } from "./doc/update";
import { permissionGrant } from "./permission/grant";
import { permissionList } from "./permission/list";
import { permissionRevoke } from "./permission/revoke";
import { createRegistry, type Registry, registerCapability } from "./registry";
import { workspaceGet } from "./workspace/get";
import { workspaceMemberAdd } from "./workspace/member_add";
import { workspaceMemberList } from "./workspace/member_list";
import { workspaceMemberRemove } from "./workspace/member_remove";
import { workspaceMemberUpdateRole } from "./workspace/member_update_role";
import { workspaceUpdate } from "./workspace/update";

/**
 * Build a fresh `Registry` containing every shipped capability. Returns a
 * new instance per call — registries are cheap value objects and each
 * process (server, CLI) owns its own.
 */
export function createDefaultRegistry(): Registry {
  return createRegistry([
    registerCapability(auditGet),
    registerCapability(auditList),
    registerCapability(collectionCreate),
    registerCapability(collectionDelete),
    registerCapability(collectionList),
    registerCapability(collectionMove),
    registerCapability(collectionRestore),
    registerCapability(collectionUpdate),
    registerCapability(docCreate),
    registerCapability(docDelete),
    registerCapability(docGet),
    registerCapability(docList),
    registerCapability(docMove),
    registerCapability(docPublish),
    registerCapability(docRename),
    registerCapability(docRestore),
    registerCapability(docUnpublish),
    registerCapability(docUpdate),
    registerCapability(permissionGrant),
    registerCapability(permissionList),
    registerCapability(permissionRevoke),
    registerCapability(workspaceGet),
    registerCapability(workspaceMemberAdd),
    registerCapability(workspaceMemberList),
    registerCapability(workspaceMemberRemove),
    registerCapability(workspaceMemberUpdateRole),
    registerCapability(workspaceUpdate),
  ]);
}
