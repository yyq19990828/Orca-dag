#!/usr/bin/env node
// Validate skill/SKILL.md so a bad edit can't silently break distribution.
//
// `npx skills add ZinkLu/Orca-Orchestration --skill orca-dag` is the install
// path for the skill half of this project. The skills CLI discovers the skill
// by walking the repo for SKILL.md and reads its *frontmatter* for the name and
// the description the agent matches against — a dropped `---` fence or a
// renamed `name:` changes the install command out from under every user, and
// nothing else in the build would notice.
//
// Deliberately hand-rolled instead of shelling out to `npx skills add . --list`:
// that command prompts when it detects no coding agent, which would hang CI.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "skill", "SKILL.md");
const EXPECTED_NAME = "orca-dag";

const text = readFileSync(path, "utf8");
const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
if (!match) {
  console.error(`skill/SKILL.md: missing YAML frontmatter (must open with a --- fence on line 1)`);
  process.exit(1);
}

const body = match[1];
const errors = [];
const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim().replace(/^["']|["']$/g, "");
const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim().replace(/^["']|["']$/g, "");

if (name !== EXPECTED_NAME) {
  errors.push(`name must stay "${EXPECTED_NAME}" (the documented install command hardcodes it), got ${name ?? "nothing"}`);
}
if (!description) {
  errors.push("description is required — it is the only thing an agent sees when deciding to load the skill");
} else if (description.length < 40) {
  errors.push(`description is ${description.length} chars; too terse to route on (want a "use when …" sentence)`);
}
if (text.slice(match[0].length).trim().length < 500) {
  errors.push("body is nearly empty — the skill teaches the whole orca orchestration workflow");
}

// --- Drift guards (Phase 7) ------------------------------------------------
// The skill is a thin project workflow: command syntax and lifecycle rules
// belong to the runtime-matched guide the CLI itself prints. Two ways it can
// silently regress:
//   1. someone deletes the guide-loading step, so agents trust stale copies;
//   2. someone pastes copy-pasteable orchestration mutation command lines back
//      in — they drift from the installed runtime and contradict the guide.
// `docBody` = everything after the frontmatter (`body` above is frontmatter).
const docBody = text.slice(match[0].length);

if (!/skills\s+get\s+orchestration/.test(docBody)) {
  errors.push(
    "body never loads the runtime-matched orchestration guide (`skills get orchestration`) — " +
      "the skill must delegate command syntax to the guide so installed instructions cannot drift from the runtime",
  );
}

if (!/1\.4\.205/.test(docBody)) {
  errors.push("body does not state the Orca 1.4.205 execution baseline");
}

// Copy-pasteable mutation command lines in fenced code blocks are exactly the
// hard-coded guidance that bypasses runtime guide loading. Naming an operation
// in prose is fine; spelling out its flags here is the duplication that drifts.
const MUTATION_SUBCOMMAND =
  /\borchestration\s+(run-create|task-create|task-update|gate-create|gate-resolve|dispatch|worker-start|worker-done|worker-stop|worker-abandon|worker-release|worker-retain|reset)\b/;
for (const fence of docBody.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
  const hit = MUTATION_SUBCOMMAND.exec(fence[1]);
  if (hit) {
    errors.push(
      `fenced code block hard-codes an orchestration \`${hit[1]}\` command line — ` +
        "name the operation in prose and let `skills get orchestration` own the syntax",
    );
    break; // one complaint is enough to fail the check
  }
}

if (errors.length) {
  for (const e of errors) console.error(`skill/SKILL.md: ${e}`);
  process.exit(1);
}

console.log(`✅ skill/SKILL.md ok — installable as \`npx skills add ZinkLu/Orca-Orchestration --skill ${name}\``);
