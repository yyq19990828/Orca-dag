# Documentation

English | [简体中文](README_zh.md) · [Project README](../README.md)

Start with the project README for installation and a first Run. Choose a guide below for the task you are doing; use the references for exact settings and boundaries.

## Tutorials

| I want to… | Guide |
| --- | --- |
| Turn a requirement into a task DAG and execute it | [Plan and run a DAG](tutorials/orchestration.md) |
| Isolate work, share a lane, or integrate Stage changes | [Worktree isolation](tutorials/worktree-isolation.md) |
| Configure, monitor, recover, upgrade, or uninstall the viewer | [Viewer operations](tutorials/viewer-operations.md) |
| Install or develop the native Orca companion plugin | [Orchestration Panel plugin](../plugin/README.md) |

## Reference

| Topic | Contents |
| --- | --- |
| [Compatibility and verified versions](reference/compatibility.md) | Viewing/execution floors, launch-path requirements, OMP `--effort`, and the recorded real-runtime verification matrix |
| [Viewer features](reference/viewer-features.md) | Dual-surface Sidebar + 4-zone IDE workbench, DAG canvas, live Session tool cards, L1 native resume, launch controls, messages, recovery, audit evidence, and interface language |
| [Architecture and boundaries](reference/architecture.md) | Run/Task/Dispatch ownership, embedded plugin server, `OutputTail` SSE, L1 native resume, coordinator safety, CLI/workspace resolution, and source layout |
| [HTTP API and security](reference/http-api.md) | Loopback access, mutation tokens, plugin bridge routes, live output SSE, native resume routes, and the complete route inventory |
| [Skill Chinese review copy](SKILL_zh.md) | Chinese reading/review translation of [`skill/SKILL.md`](../skill/SKILL.md) (documentation only, not installed as a harness skill) |

## Development

- [Development and releases](development.md): source setup, checks, plugin builds (`build:plugin-panel`, `build:plugin`), opt-in real-provider verification, packaging, and npm/GitHub releases.
- [UI layout design](ui-layout.md): Dual-surface Sidebar + 4-zone monochrome IDE workbench presentation rules, responsive behavior, and browser verification.

Orca remains the authority for lifecycle operations. Obtain command syntax from the installed runtime's orchestration guide and follow each worker's live preamble; these documents do not grant authority to stop, retry, or release an unknown worker.
