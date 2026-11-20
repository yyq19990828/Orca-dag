#!/usr/bin/env node
// Validate skill/SKILL.md and skill/references/*.md so a bad edit can't silently break distribution.
//
// `npx skills add yyq19990828/Orca-dag --skill orca-dag` is the install
// path for the skill half of this project. The skills CLI discovers the skill
// by walking the repo for SKILL.md and reads its *frontmatter* for the name and
// the description the agent matches against — a dropped `---` fence or a
// renamed `name:` changes the install command out from under every user, and
// nothing else in the build would notice.
//
// Deliberately hand-rolled instead of shelling out to `npx skills add . --list`:
// that command prompts when it detects no coding agent, which would hang CI.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(root, "skill");
const path = join(skillDir, "SKILL.md");
const refsDir = join(skillDir, "references");
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

if (!docBody.includes("USER_PREFERENCES.md")) {
  errors.push("body must document first-run user preference onboarding/loading in USER_PREFERENCES.md");
}

// Planning output must stay isolated by plan, rather than silently overwriting
// the old fixed docs/ files. These local artifacts never belong in Stage commits.
for (const file of ["PRD.md", "TECH_SPEC.md"]) {
  if (!docBody.includes(`.orca-dag/<timestamp>/${file}`)) {
    errors.push(`body must write ${file} under .orca-dag/<timestamp>/`);
  }
}
if (!docBody.includes(".gitignore") || !docBody.includes("uninstall")) {
  errors.push("body must explain planning ignore setup and uninstall behavior");
}

// Discover and validate bundled reference handbooks (never reading untracked local USER_PREFERENCES.md).
const refFiles = [];
try {
  const dirStat = lstatSync(refsDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    errors.push("skill/references must be a real directory (not a symbolic link)");
  } else {
    for (const entry of readdirSync(refsDir).sort()) {
      if (!entry.endsWith(".md") || entry === "USER_PREFERENCES.md") continue;
      const full = join(refsDir, entry);
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push(`skill/references/${entry} must be a regular file (not a symbolic link)`);
        continue;
      }
      const refText = readFileSync(full, "utf8");
      if (refText.trim().length < 200) {
        errors.push(`skill/references/${entry} is nearly empty`);
      }
      refFiles.push({ rel: `references/${entry}`, label: `skill/references/${entry}`, content: refText });
    }
  }
} catch (err) {
  errors.push(`failed to read skill/references/: ${String(err?.message ?? err)}`);
}

if (refFiles.length === 0) {
  errors.push("expected modular reference handbooks under skill/references/*.md");
}

for (const ref of refFiles) {
  if (!docBody.includes(ref.rel)) {
    errors.push(`skill/SKILL.md never references bundled handbook ${ref.rel}`);
  }
}

const localSection = /### Skill Handbooks[^\n]*\n([\s\S]*?)(?:\n### |\n## |$)/.exec(docBody)?.[1] ?? "";
for (const refHit of localSection.matchAll(/references\/[a-z0-9-]+\.md/g)) {
  if (!refFiles.some((ref) => ref.rel === refHit[0])) {
    errors.push(`skill/SKILL.md lists missing handbook ${refHit[0]} under Skill Handbooks`);
  }
}

// Copy-pasteable mutation command lines in fenced code blocks are exactly the
// hard-coded guidance that bypasses runtime guide loading. Naming an operation
// in prose is fine; spelling out its flags here is the duplication that drifts.
const MUTATION_SUBCOMMAND =
  /\borchestration\s+(run-create|task-create|task-update|gate-create|gate-resolve|dispatch|worker-start|worker-done|worker-stop|worker-abandon|worker-release|worker-retain|reset)\b/;

for (const doc of [{ label: "skill/SKILL.md", content: docBody }, ...refFiles]) {
  if (/docs\/(PRD|TECH_SPEC)\.md/.test(doc.content)) {
    errors.push(`${doc.label} still references shared docs/ planning files; use per-plan timestamp directories`);
  }
  if (doc.content.includes(".orca/<timestamp>/")) {
    errors.push(`${doc.label} still writes planning output under .orca/; use .orca-dag/<timestamp>/`);
  }
  for (const fence of doc.content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const hit = MUTATION_SUBCOMMAND.exec(fence[1]);
    if (hit) {
      errors.push(
        `${doc.label}: fenced code block hard-codes an orchestration \`${hit[1]}\` command line — ` +
          "name the operation in prose and let `skills get orchestration` own the syntax",
      );
      break;
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`skill check failed: ${e}`);
  process.exit(1);
}

console.log(
  `✅ skill/SKILL.md + ${refFiles.length} reference file(s) ok — installable as \`npx skills add yyq19990828/Orca-dag --skill ${name}\``,
);
