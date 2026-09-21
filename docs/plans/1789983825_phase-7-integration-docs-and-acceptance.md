# Phase 7: Integration, Documentation and Acceptance

## Objective

Integrate every Epic branch, remove duplication, validate lifecycle boundaries, update documentation and produce release-quality evidence.

## Scope

- Review all Phase 1–6 diffs against the Epic invariants.
- Resolve type/API/UI duplication without removing load-bearing Orca comments.
- Ensure Activity/Chat, Worker Operations, Run Health and DAG Ready Queue remain separate but coordinated surfaces.
- Add missing regression and HTTP-boundary tests.
- Update `README.md` and `README_zh.md` together.
- Verify production build and representative browser flows.
- Write a concise evidence document under `docs/plans/` mapping every Epic acceptance criterion to code and tests.

## Required acceptance scenarios

1. Empty Run with retained messages.
2. Viewer-owned, external and unbound coordinator states.
3. Historical released worker and live unverifiable remote worker.
4. Agent-wait detail present, absent and unknown.
5. Threaded urgent question and coordinator reply.
6. Saturated inbox completeness warning.
7. Parent task plus dependency edges and a blocked gate.
8. Completed and absent request receipts.
9. Confirmed `@all` guidance with enqueue-only wording.
10. OpenCode model `zai-coding-plan/glm-5.3-flash#high` preserved through validation and launch construction.

## Constraints

- Do not paper over failing tests or relax security validation to make fixtures pass.
- Do not create generated/runtime artifacts in Git.
- Preserve user changes and keep unrelated refactors out of scope.
- Browser validation establishes presentation behavior; server tests establish lifecycle behavior. Report them separately.

## Verification

- Run focused tests for every changed subsystem.
- Run `npm run check`.
- Run `git diff --check`.
- Build or stage no release artifact unless required by an existing check.
- Perform a visual pass at the supported desktop viewport, covering panel resize/open/close and graph fit behavior.

## Definition of done

- Every Epic acceptance criterion has code and evidence.
- All seven phases have explicit outcomes.
- No reclaimable worker terminal or unresolved coordinator cleanup debt remains from this implementation Run.
- The worktree contains only intended source, test and documentation changes.

