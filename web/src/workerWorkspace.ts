import type { WorkerRowView } from "./types";

type Workspace = NonNullable<WorkerRowView["projection"]>["workspace"];

/** Return renderable Orca workspace identity across old and current receipts. */
export function workerWorkspaceLabel(workspace: Workspace): string | null {
  if (typeof workspace === "string") return workspace || null;
  if (workspace && typeof workspace === "object" && typeof workspace.id === "string") {
    return workspace.id || null;
  }
  return null;
}
