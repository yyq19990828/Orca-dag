# User Preferences & First-Run Onboarding (`USER_PREFERENCES.md`)

`orca-dag` supports a user-editable persistent preferences file stored right inside the installed skill folder:

- Path: **`<skill-dir>/USER_PREFERENCES.md`** (alongside `SKILL.md`, where `<skill-dir>` is the directory containing the `SKILL.md` you loaded).
- Distribution guarantee:
  - Ignored in git when developing from a repo checkout (`skill/USER_PREFERENCES.md` is never packaged into npm tarballs or standalone binaries).
  - Never overwritten when upgrading `orca-dag`.
  - Preserved during ordinary `npx orca-orchestration-launcher uninstall`, and deleted only when the user passes `--purge`.

---

## When to Load vs When to Onboard

### Returning user (`USER_PREFERENCES.md` already exists)
1. Read `<skill-dir>/USER_PREFERENCES.md` silently during Phase 0.
2. Adopt its fields as session defaults across Phase 1–4.
3. Include a brief **1-line echo** at the start of Phase 1 (for example: *“Using saved preferences: Orchestration Panel handover · codex · adaptive docs.”*).
4. Explicit requests in the current conversation **always override** saved file defaults.

### First-run user (`USER_PREFERENCES.md` does not exist yet)
Run a **single, low-friction onboarding turn** in Phase 0 before diving into PRD questions:

1. Explain briefly that no `USER_PREFERENCES.md` exists yet in `<skill-dir>`, and saving defaults once will tailor future sessions automatically.
2. Ask the user to reply concisely (or say `"defaults"` / `"skip"` to accept defaults immediately):
   - **Coordination mode**:
     - `human_panel` (recommended default): build DAG and hand off to Orchestration Panel
     - `agent_coordinator`: drive execution directly from this Orca agent chat/session
     - `ask_each_time`: ask after every DAG
   - **Default verified harness & model/effort**: e.g., `codex`, `claude`, `opencode`, `omp`, `antigravity`, or `ask`; optional `default_model` / `default_effort` / `opencode_ui`
   - **Planning doc depth & language**:
     - `planning_docs`: `adaptive` (match S/M/L rubric), `full` (complete PRD + TECH_SPEC), or `spec_only` (concise PRD + detailed TECH_SPEC)
     - `language`: `match_conversation` (recommended), `zh`, or `en`
   - **Default workspace & gate style**:
     - `workspace_strategy`: `current` (default), `isolated_worktrees`, or `stage_git`
     - `approval_gates`: `key_milestones` (recommended), `always_before_exec`, or `minimal`
     - `max_concurrency_hint`: e.g. `2`–`4`
3. Write `<skill-dir>/USER_PREFERENCES.md` using the canonical template below.
   - **Safety check before writing**: Write **only** inside `<skill-dir>/USER_PREFERENCES.md` after confirming neither `<skill-dir>` nor the target file is an unexpected symlink pointing outside the skill directory.
   - **Read-only fallback**: If `<skill-dir>` is not writable (for instance a read-only Nix/container mount or system path), apply the user's choices for the active session, show the generated Markdown block, and suggest saving it manually if needed.

### Updating preferences later
Whenever the user asks to view or change their defaults (e.g. *"update my orca-dag preferences"*, *"switch default harness to codex"*), read the existing `<skill-dir>/USER_PREFERENCES.md`, update only the requested fields, preserve user-written notes under `## Notes`, and confirm the saved diff.

---

## Canonical `USER_PREFERENCES.md` Template

Write the file in Markdown with a structured YAML header so both LLMs and humans can read and edit it cleanly:

```markdown
---
coordination_mode: human_panel          # human_panel | agent_coordinator | ask_each_time
default_harness: ask                    # claude | codex | opencode | omp | antigravity | ask
default_model: default                  # explicit provider/model selector, or "default"
default_effort: default                 # low | medium | high | xhigh | default
opencode_ui: auto                       # auto | mini | tui
planning_docs: adaptive                 # adaptive | full | spec_only
language: match_conversation            # match_conversation | zh | en
workspace_strategy: current             # current | isolated_worktrees | stage_git
approval_gates: key_milestones          # key_milestones | always_before_exec | minimal
max_concurrency_hint: 2                 # suggested Orchestration Panel max concurrency (1-16)
updated_at: "YYYY-MM-DD"
---

# Orca DAG User Preferences

- **Coordination**: <1-sentence summary of preferred handover or agent-driven workflow>
- **Harnesses & Models**: <e.g., prefer codex for backend, claude for architecture/docs, or ask per Run>
- **Documentation & Spec Style**: <e.g., concise bullet PRDs, strict test evidence requirements>
- **Review & Gate Habits**: <e.g., always insert an approval gate before schema migrations or production deploy scripts>

## Notes

- Keep freeform workspace conventions, recurring test commands, or code style rules here.
```

---

## Precedence & Integrity Rules

1. **Prompt > File > Built-in Default**: Explicit per-task instructions in chat override `USER_PREFERENCES.md`, which overrides built-in handbook defaults.
2. **Advisory Only (Never Runtime Authority)**: `USER_PREFERENCES.md` never replaces Orca's Run state, never writes `.orca-dag/config.json` behind the user's back, and never triggers execution without user confirmation.
3. **Zero Secrets Policy**: Never write API keys, bearer tokens, session cookies, passwords, SSH private details, or environment secrets into `USER_PREFERENCES.md`.
4. **Never Reuse Verified-Refused Harnesses**: If a user asks for `gemini`, `grok`, `cursor`, `droid`, or `kimi` as a worker harness, politely explain they are unverified/refused by Orchestration Panel execution admission and prompt for one of `claude`, `codex`, `opencode`, `omp`, or `antigravity`.
