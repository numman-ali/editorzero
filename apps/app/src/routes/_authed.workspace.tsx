import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { EditWorkspace } from "../components/edit-workspace";
import { workspaceGetQueryOptions } from "../lib/workspace";

/**
 * `/workspace` — the workspace settings screen: the `workspace.update
 * × Web UI` cell's host (the `workspace.get` cell's data, already
 * warmed by the `_authed` layout, renders the header + facts).
 * SINGULAR route on purpose: `/workspaces` is the trunk's API domain
 * and a reserved prefix (ADR 0035 §2) — the `/space` + `/doc`
 * precedent. Reached from the sidebar identity block (its one
 * interaction — there is still nothing to *switch* to; the deployment
 * IS one workspace, ADR 0040 Model B).
 *
 * Header: name + slug (the slug is immutable by the capability —
 * bootstrap-derived — so it renders as identity, not as a field).
 * Body: `EditWorkspace`, the facts + PATCH-form disclosure.
 *
 * Coverage: render-only; decisions live unit-tested in
 * `lib/workspace.ts`. Proven by the marked Playwright spec
 * (`packages/e2e/test/workspace.spec.ts`, `proves-capability-cell:
 * workspace.update`).
 */
export const Route = createFileRoute("/_authed/workspace")({
  loader: ({ context }) => context.queryClient.ensureQueryData(workspaceGetQueryOptions()),
  component: WorkspaceScreen,
});

function WorkspaceScreen() {
  const { data: workspace } = useSuspenseQuery(workspaceGetQueryOptions());
  return (
    <section className="panel" aria-labelledby="workspace-heading">
      <div className="ph">
        <h2 className="t" id="workspace-heading">
          {workspace.name}
        </h2>
        <span className="pth">{workspace.slug}</span>
      </div>
      <EditWorkspace workspace={workspace} />
    </section>
  );
}
