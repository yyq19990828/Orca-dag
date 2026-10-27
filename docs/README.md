# Documentation

English | [简体中文](README_zh.md) · [Project README](../README.md)

Start with the project README for installation and a first Run. Choose a guide below for the task you are doing; use the references for exact settings and boundaries.

## Tutorials

| I want to… | Guide |
| --- | --- |
| Turn a requirement into a task DAG and execute it | [Plan and run a DAG](tutorials/orchestration.md) |
| Isolate work, share a lane, or integrate Stage changes | [Worktree isolation](tutorials/worktree-isolation.md) |
| Configure, monitor, recover, upgrade, or uninstall the viewer | [Viewer operations](tutorials/viewer-operations.md) |

## Reference

| Topic | Contents |
| --- | --- |
| [Compatibility and verified versions](reference/compatibility.md) | Viewing/execution floors, launch-path requirements, and the recorded real-runtime verification matrix |
| [Viewer features](reference/viewer-features.md) | Canvas, launch controls, messages, recovery, audit evidence, and interface language |
| [Architecture and boundaries](reference/architecture.md) | Run/Task/Dispatch ownership, coordinator safety, CLI/workspace resolution, and source layout |
| [HTTP API and security](reference/http-api.md) | Loopback access, mutation tokens, readiness, and the complete route inventory |

## Development

- [Development and releases](development.md): source setup, checks, opt-in real-provider verification, packaging, and npm/GitHub releases.
- [UI layout design](ui-layout.md): presentation rules and layout acceptance scenarios.

Orca remains the authority for lifecycle operations. Obtain command syntax from the installed runtime's orchestration guide and follow each worker's live preamble; these documents do not grant authority to stop, retry, or release an unknown worker.
