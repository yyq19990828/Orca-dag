// Install `skill/SKILL.md` into the coding agents on this machine.
//
// Why the viewer does this at all: the project has two halves that are useless
// apart — the skill teaches your agent to *build* the DAG, the viewer *runs* it
// — and making people install them separately is one step too many. So
// `npx orca-orchestration-launcher` installs the skill on startup and then serves the UI. One
// command, everything works.
//
// It is deliberately dumb and idempotent: write the file, don't touch anything
// else. No symlinks (they break when the npx cache is evicted), no agent config
// edits, no network. Opt out with `--no-skill` / `ORCA_DAG_NO_SKILL=1`.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { loadEmbeddedSkill } from "./webAssets";
import { homedir } from "node:os";

export const SKILL_NAME = "orca-dag";

export interface AgentSkillDir {
  agent: string;
  parent: string;
  skills: string;
  env?: string;
  sharedParents?: Array<{ agent: string; parent: string; env?: string }>;
  legacySkills?: string[];
}

/**
 * Current global locations plus the config roots that prove a shared reader is
 * installed. The shared agents all consume ~/.agents/skills, so that one
 * canonical directory is written once when any known reader is present.
 */
export const AGENT_SKILL_DIRS: AgentSkillDir[] = [
  { agent: "Claude Code", parent: ".claude", skills: ".claude/skills", env: "CLAUDE_CONFIG_DIR" },
  { agent: "Cursor", parent: ".cursor", skills: ".cursor/skills" },
  { agent: "Gemini CLI", parent: ".gemini", skills: ".gemini/skills" },
  { agent: "Droid", parent: ".factory", skills: ".factory/skills" },
  { agent: "Grok Build", parent: ".grok", skills: ".grok/skills", env: "GROK_HOME" },
  { agent: "Kiro CLI", parent: ".kiro", skills: ".kiro/skills", env: "KIRO_HOME" },
  { agent: "Qoder", parent: ".qoder", skills: ".qoder/skills" },
  { agent: "CodeBuddy", parent: ".codebuddy", skills: ".codebuddy/skills" },
  {
    agent: "Codex/OpenCode/Pi/OMP/Kimi",
    parent: ".agents",
    skills: ".agents/skills",
    sharedParents: [
      { agent: "Codex", parent: ".codex", env: "CODEX_HOME" },
      { agent: "OpenCode", parent: ".config/opencode" },
      { agent: "Pi", parent: ".pi" },
      { agent: "OMP", parent: ".omp" },
      { agent: "Kimi", parent: ".kimi" },
      { agent: "Kimi", parent: ".kimi-code" },
    ],
    // These were direct destinations in older viewer versions.
    legacySkills: [".codex/skills", ".config/opencode/skills"],
  },
];

export interface ResolvedAgentSkillDir {
  agent: string;
  skills: string;
  install: boolean;
  migrateFrom: string[];
  safeRoot: string;
}

function configuredRoot(home: string, parent: string, envName: string | undefined, env: NodeJS.ProcessEnv): string {
  const override = envName ? env[envName]?.trim() : undefined;
  if (override && isAbsolute(override)) {
    const root = resolve(override);
    // A relocated config home is agent-specific, not HOME or an ancestor
    // whose shared skills would be changed for unrelated tools.
    if (!isInside(root, home)) return root;
  }
  return join(home, parent);
}

function isInside(base: string, path: string): boolean {
  const pathFromBase = relative(resolve(base), resolve(path));
  return pathFromBase === "" || (pathFromBase !== ".." && !pathFromBase.startsWith(`..${sep}`) && !isAbsolute(pathFromBase));
}

function safetyRoot(home: string, path: string): string {
  return isInside(home, path) ? home : parse(resolve(path)).root;
}

/** True only when every component below the safety boundary is a real directory. */
function isExistingRealDirectory(path: string, boundary: string): boolean {
  if (!isSafeSkillPath(path, false, boundary)) return false;
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Inspect config-path components with lstat: existsSync follows links and
 * misses dangling links, either of which could make an install escape the
 * config root. HOME is the boundary for ordinary agent folders; relocated roots
 * outside HOME are checked from the filesystem root, including their ancestors.
 * Uninstall may allow the final skill-directory link so it can unlink the link
 * itself, but it never traverses a linked ancestor.
 */
export function isSafeSkillPath(path: string, allowFinalSymlink = false, boundary = homedir()): boolean {
  const absolute = resolve(path);
  const normalizedBoundary = resolve(boundary);
  const insideBoundary = isInside(normalizedBoundary, absolute);
  const currentBase = insideBoundary ? normalizedBoundary : parse(absolute).root;
  const relativePath = insideBoundary ? relative(normalizedBoundary, absolute) : absolute.slice(currentBase.length);
  const parts = relativePath.split(sep).filter(Boolean);
  let current = currentBase;
  let baseInfo: Stats;
  try {
    baseInfo = lstatSync(current);
  } catch {
    return false;
  }
  if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) return false;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let info: Stats;
    try {
      info = lstatSync(current);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (info.isSymbolicLink()) return allowFinalSymlink && i === parts.length - 1;
    if (i < parts.length - 1 && !info.isDirectory()) return false;
  }
  return true;
}

/**
 * Resolve installation and uninstall paths together. The install flag only
 * becomes true when an agent config parent already exists; legacy-only paths
 * remain discoverable to uninstall without being re-created on new installs.
 */
export function resolveAgentSkillDirs(home = homedir(), env = process.env): ResolvedAgentSkillDir[] {
  const locations: ResolvedAgentSkillDir[] = [];
  const add = (agent: string, skills: string, install: boolean, migrateFrom: string[] = [], safeRoot = home) => {
    const path = resolve(skills);
    const existing = locations.find((location) => location.skills === path);
    if (existing) {
      existing.install ||= install;
      existing.migrateFrom = [...new Set([...existing.migrateFrom, ...migrateFrom.map((source) => resolve(source))])];
      if (isInside(home, path)) existing.safeRoot = resolve(home);
    } else {
      locations.push({
        agent,
        skills: path,
        install,
        migrateFrom: [...new Set(migrateFrom.map((source) => resolve(source)))],
        safeRoot: resolve(safeRoot),
      });
    }
  };
  for (const entry of AGENT_SKILL_DIRS) {
    if (entry.sharedParents) {
      const sharedSkills = join(home, entry.skills);
      const parents = [
        { path: join(home, entry.parent), safeRoot: home },
        ...entry.sharedParents.map((parent) => {
          const path = configuredRoot(home, parent.parent, parent.env, env);
          return { path, safeRoot: safetyRoot(home, path) };
        }),
      ];
      const install = parents.some(({ path, safeRoot }) => isExistingRealDirectory(path, safeRoot));
      const migrateFrom = (entry.legacySkills ?? [])
        .map((skills) => join(home, skills))
        .map((skills) => join(skills, SKILL_NAME));
      const relocatedCodex = entry.sharedParents.find((parent) => parent.agent === "Codex");
      if (relocatedCodex) {
        const codexRoot = configuredRoot(home, relocatedCodex.parent, relocatedCodex.env, env);
        const defaultCodexSkills = join(home, relocatedCodex.parent, "skills");
        const configuredCodexSkills = join(codexRoot, "skills");
        if (resolve(defaultCodexSkills) !== resolve(configuredCodexSkills)) {
          add("Codex (legacy)", defaultCodexSkills, false);
          add("Codex", configuredCodexSkills, false, [], safetyRoot(home, codexRoot));
        }
      }
      add(entry.agent, sharedSkills, install, migrateFrom, home);
      for (let i = 0; i < (entry.legacySkills ?? []).length; i++) {
        const legacySkills = join(home, entry.legacySkills![i]);
        add(i === 0 ? "Codex (legacy)" : "OpenCode (legacy)", legacySkills, false);
      }
      continue;
    }

    const defaultSkills = join(home, entry.skills);
    const root = configuredRoot(home, entry.parent, entry.env, env);
    const safeRoot = safetyRoot(home, root);
    const skills = entry.env ? join(root, "skills") : defaultSkills;
    const relocated = resolve(skills) !== resolve(defaultSkills);
    add(entry.agent, skills, isExistingRealDirectory(root, safeRoot), relocated ? [join(defaultSkills, SKILL_NAME)] : [], safeRoot);
    if (relocated) add(`${entry.agent} (legacy)`, defaultSkills, false);
  }

  return locations;
}


function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Move a previous single-file installation into its new canonical location
 * only when that destination is absent. Extra files, links and user checkouts
 * are deliberately left at their original path.
 */
function migrateLegacySkillDir(sources: string[], destination: string, destinationBoundary: string): void {
  if (!isSafeSkillPath(destination, false, destinationBoundary) || lstatIfPresent(destination)) return;
  for (const source of sources) {
    if (!isSafeSkillPath(source)) continue;
    try {
      const info = lstatSync(source);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const entries = readdirSync(source);
      if (entries.length !== 1 || entries[0] !== "SKILL.md") continue;
      const skillFile = lstatSync(join(source, "SKILL.md"));
      if (!skillFile.isFile() || skillFile.isSymbolicLink()) continue;
      const parent = dirname(destination);
      if (!isSafeSkillPath(parent, false, destinationBoundary)) continue;
      mkdirSync(parent, { recursive: true });
      if (!isSafeSkillPath(destination, false, destinationBoundary) || lstatIfPresent(destination)) continue;
      renameSync(source, destination);
      return;
    } catch {
      // A cross-volume move or an unwritable legacy directory is non-fatal.
    }
  }
}

/**
 * Find the skill text: embedded in the binary, or on disk. A broken package or
 * damaged embedded payload must not prevent the viewer itself from starting.
 *
 * Disk candidates cover the npm package (`<pkg>/skill/SKILL.md`, two levels up
 * from `<pkg>/dist/server/`) and a dev checkout (`<repo>/skill/SKILL.md`, two
 * levels up from `<repo>/server/src/`) — which happen to be the same relative
 * path, the same coincidence the web/dist fallback relies on.
 */
async function readSkill(here: string): Promise<string | null> {
  try {
    const embedded = await loadEmbeddedSkill();
    if (embedded) return embedded;
  } catch {
    // Fall back to disk if the binary's embedded assets are unavailable.
  }
  for (const candidate of [join(here, "..", "..", "skill", "SKILL.md"), join(here, "..", "..", "..", "skill", "SKILL.md")]) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    } catch {
      // Continue to the other package layout; installation is best effort.
    }
  }
  return null;
}

/**
 * Write the skill into every agent present on this machine.
 *
 * Never throws: a read-only home directory or a weird agent layout must not
 * stop the viewer from starting — the skill is a convenience, the UI is the
 * product.
 */
export async function installSkill(moduleDir: string, enabled: boolean): Promise<SkillInstallResult> {
  const result: SkillInstallResult = { installed: [], upToDate: [], skipped: null };
  if (!enabled) {
    result.skipped = "disabled";
    return result;
  }

  const text = await readSkill(moduleDir);
  if (!text) {
    result.skipped = "not-found";
    return result;
  }

  for (const location of resolveAgentSkillDirs()) {
    if (!location.install) continue;
    const dir = join(location.skills, SKILL_NAME);
    const target = join(dir, "SKILL.md");
    try {
      if (!isSafeSkillPath(dir, false, location.safeRoot) || !isSafeSkillPath(target, false, location.safeRoot)) continue;
      let dirInfo = lstatIfPresent(dir);
      if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) continue;
      let targetInfo = lstatIfPresent(target);
      if (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) continue;

      if (!dirInfo && location.migrateFrom.length > 0) {
        migrateLegacySkillDir(location.migrateFrom, dir, location.safeRoot);
        dirInfo = lstatIfPresent(dir);
        targetInfo = lstatIfPresent(target);
        if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) continue;
        if (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) continue;
      }

      // Rewriting only on change keeps the log quiet on every restart and keeps
      // mtimes stable for agents that cache their skill index.
      if (targetInfo && readFileSync(target, "utf8") === text) {
        result.upToDate.push(target);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      // Re-check after mkdir so a pre-existing or raced-in link is never used.
      if (!isSafeSkillPath(dir, false, location.safeRoot) || !isSafeSkillPath(target, false, location.safeRoot)) continue;
      targetInfo = lstatIfPresent(target);
      if (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) continue;
      writeFileSync(target, text);
      result.installed.push(target);
    } catch {
      // Unwritable directory — skip this agent silently.
    }
  }
  return result;
}

export interface SkillInstallResult {
  installed: string[];
  upToDate: string[];
  skipped: "disabled" | "not-found" | null;
}


/** One-line startup summary; returns null when there is nothing worth saying. */
export function describeSkillInstall(result: SkillInstallResult): string | null {
  if (result.skipped === "not-found") return `Skill "${SKILL_NAME}" not found in this install — skipped.`;
  if (result.skipped) return null;
  if (result.installed.length > 0) {
    return `Skill "${SKILL_NAME}" installed for ${result.installed.length} agent(s): ${result.installed
      .map((p) => p.replace(homedir(), "~"))
      .join(", ")}`;
  }
  if (result.upToDate.length > 0) return `Skill "${SKILL_NAME}" already up to date (${result.upToDate.length} agent(s)).`;
  return `No coding agent found to install the skill "${SKILL_NAME}" into — see the README to place it by hand.`;
}
