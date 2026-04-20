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
 * at the module level. The parity contract test added in the next
 * slice (commit 3) closes the remaining loop: every capability whose
 * `surfaces` array contains `"cli"` must appear in this registry's
 * `list()` output, and every command in the generated `ez <domain>`
 * tree must correspond to a capability with `surfaces: ["cli"]`.
 *
 * **Today's registry** is N=1 (doc.list). The next commit widens it to
 * the six other doc capabilities + wires the parity check; no code
 * changes in this file between slices are expected beyond adding
 * capability imports.
 */

import { createRegistry, docList, registerCapability } from "@editorzero/capabilities";

export const cliRegistry = createRegistry([registerCapability(docList)]);
