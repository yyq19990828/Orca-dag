/** Focus an existing Operations control without duplicating its mutation rules. */
export type OperationFocus = { kind: "gate" | "recovery" | "worker"; id: string };

export function focusOperation(root: HTMLElement | null, focus: OperationFocus): boolean {
  if (!root) return false;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-operation-kind][data-operation-id]"));
  const target = candidates.find((candidate) =>
    candidate.dataset.operationKind === focus.kind && candidate.dataset.operationId === focus.id,
  ) ?? (focus.kind === "worker"
    ? candidates.find((candidate) =>
        candidate.dataset.operationKind === "worker" && candidate.dataset.operationTaskId === focus.id,
      )
    : undefined);
  if (!target) return false;

  // A Worker row loads its detailed evidence only when expanded. Keep that
  // same user-facing control and its existing permission checks in charge.
  const toggle = focus.kind === "worker"
    ? target.querySelector<HTMLButtonElement>(".workers__toggle")
    : null;
  if (toggle && !target.querySelector(".workers__detail")) toggle.click();
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  (toggle ?? target).focus({ preventScroll: true });
  target.classList.add("operation-target");
  window.setTimeout(() => target.classList.remove("operation-target"), 2200);
  return true;
}
