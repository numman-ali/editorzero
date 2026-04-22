/**
 * CLI-side capability registry (ADR 0021 §CLI generator).
 *
 * The CLI keeps its own registry because it's a separate process from
 * the server — it needs to know which capabilities to expose as
 * subcommands without an out-of-band registry-sync hop. The source of
 * truth for every capability module lives in
 * `packages/capabilities/src/<domain>/<action>.ts`; this file just
 * gathers them into one `createRegistry(...)` call.
 *
 * Drift between the server's and CLI's registry would break the
 * capability-matrix parity invariant (AGENTS.md invariant 4). Both
 * registries import the same capability modules — they can't diverge
 * at the module level. The parity coherence test in
 * `generator/parity.unit.test.ts` closes the remaining loop:
 *
 *   - Every capability in this registry whose `surfaces` array
 *     contains `"cli"` must have `deriveHttpBinding(cap)` point at
 *     a real registered route on the api-server trunk (route-parity
 *     guard: catches irregular plurals, prefix drift, verb drift).
 *   - Every capability in this registry whose `surfaces` array
 *     contains `"cli"` must be reachable as a subcommand under its
 *     `<domain>` top-level command (root-wiring guard: catches a
 *     capability added here but not exposed via `index.ts`).
 *   - No orphan subcommands: every generated subcommand has a
 *     capability backing it.
 *
 * **Today's registry** is the full doc domain (9 capabilities) plus
 * the collection domain slices 1+2 (create, list, update, delete,
 * restore). Adding a new capability with `surfaces: ["cli"]` means:
 * add the import + the `registerCapability(...)` call below, then
 * the generated command tree and the parity test pick it up
 * automatically.
 */

import {
  auditGet,
  auditList,
  collectionCreate,
  collectionDelete,
  collectionList,
  collectionMove,
  collectionRestore,
  collectionUpdate,
  createRegistry,
  docCreate,
  docDelete,
  docGet,
  docList,
  docMove,
  docPublish,
  docRename,
  docRestore,
  docUnpublish,
  docUpdate,
  registerCapability,
  workspaceGet,
  workspaceMemberAdd,
  workspaceMemberList,
  workspaceMemberRemove,
  workspaceMemberUpdateRole,
  workspaceUpdate,
} from "@editorzero/capabilities";

export const cliRegistry = createRegistry([
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
  registerCapability(workspaceGet),
  registerCapability(workspaceMemberAdd),
  registerCapability(workspaceMemberList),
  registerCapability(workspaceMemberRemove),
  registerCapability(workspaceMemberUpdateRole),
  registerCapability(workspaceUpdate),
]);
