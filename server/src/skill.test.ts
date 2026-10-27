import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let root: string;
let home: string;
let workspace: string;

const skillFile = fileURLToPath(new URL("./skill.ts", import.meta.url));
const uninstallFile = fileURLToPath(new URL("./uninstall.ts", import.meta.url));
const loader = import.meta.resolve("tsx");
const skillUrl = pathToFileURL(skillFile).href;
const uninstallUrl = pathToFileURL(uninstallFile).href;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "orca-dag-skill-test-")));
  home = join(root, "home");
  workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ORCA_") || ["CLAUDE_CONFIG_DIR", "GROK_HOME", "KIRO_HOME", "CODEX_HOME"].includes(key)) {
      delete env[key];
    }
  }
  return { ...env, HOME: home, ORCA_CLI_COMMAND: JSON.stringify(process.execPath), ...overrides };
}

function command(code: string, overrides: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", code], {
    cwd: root,
    env: environment(overrides),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function install(overrides: NodeJS.ProcessEnv = {}, moduleDir = dirname(skillFile)): { installed: string[]; upToDate: string[]; skipped: string | null } {
  const code = `import { installSkill } from ${JSON.stringify(skillUrl)}; console.log(JSON.stringify(await installSkill(${JSON.stringify(moduleDir)}, true)));`;
  return JSON.parse(command(code, overrides).trim().split("\n").at(-1)!);
}

function uninstall(dryRun: boolean, overrides: NodeJS.ProcessEnv = {}): string {
  const code = `import { runUninstall } from ${JSON.stringify(uninstallUrl)}; await runUninstall({ dryRun: ${dryRun}, purge: false, workspace: ${JSON.stringify(workspace)} });`;
  return command(code, overrides);
}

const sharedParents: Array<[string, string]> = [
  ["Codex", ".codex"],
  ["OpenCode", ".config/opencode"],
  ["Pi", ".pi/agent"],
  ["OMP", ".omp/agent"],
  ["Kimi", ".kimi-code"],
  ["Kimi legacy config", ".kimi"],
  ["universal shared skills", ".agents"],
];

describe("skill installer shared destinations", () => {
  for (const [agent, parent] of sharedParents) {
    it(`installs one canonical shared copy when only ${agent} is configured`, () => {
      mkdirSync(join(home, parent), { recursive: true });
      const result = install();
      const canonical = join(home, ".agents/skills/orca-dag/SKILL.md");
      assert.deepEqual(result.installed, [canonical]);
      assert.equal(existsSync(canonical), true);
      if (parent !== ".agents") assert.equal(existsSync(join(home, parent, "skills/orca-dag/SKILL.md")), false);
    });
  }

  it("recognizes an absolute relocated Codex home without a default config directory", () => {
    const relocated = join(root, "codex-config");
    mkdirSync(relocated);
    const result = install({ CODEX_HOME: relocated });
    const canonical = join(home, ".agents/skills/orca-dag/SKILL.md");
    assert.deepEqual(result.installed, [canonical]);
    assert.equal(existsSync(canonical), true);
    assert.equal(existsSync(join(home, ".codex")), false);
  });
});

describe("skill installer native destinations", () => {
  for (const [agent, variable, fallback] of [
    ["Claude Code", "CLAUDE_CONFIG_DIR", ".claude"],
    ["Grok Build", "GROK_HOME", ".grok"],
    ["Kiro CLI", "KIRO_HOME", ".kiro"],
  ] as const) {
    it(`uses the relocated ${agent} root when its default parent is absent`, () => {
      const relocated = join(root, `${agent.toLowerCase().replaceAll(" ", "-")}-config`);
      mkdirSync(relocated);
      const result = install({ [variable]: relocated });
      const target = join(relocated, "skills/orca-dag/SKILL.md");
      assert.deepEqual(result.installed, [target]);
      assert.equal(existsSync(target), true);
      assert.equal(existsSync(join(home, fallback)), false);
    });
  }

  it("ignores a relative Claude override and uses the default config root", () => {
    mkdirSync(join(home, ".claude"));
    const result = install({ CLAUDE_CONFIG_DIR: "relative/claude-config" });
    assert.deepEqual(result.installed, [join(home, ".claude/skills/orca-dag/SKILL.md")]);
    assert.equal(existsSync(join(home, "relative/claude-config")), false);
  });

  it("does not follow a symlinked relocated Claude config root", () => {
    const external = join(root, "external-claude");
    mkdirSync(external);
    const relocated = join(root, "claude-link");
    symlinkSync(external, relocated);
    const result = install({ CLAUDE_CONFIG_DIR: relocated });
    assert.deepEqual(result.installed, []);
    assert.deepEqual(readdirSync(external), []);
  });

  it("rejects relocated homes that are HOME or its ancestors without touching their shared folders", () => {
    for (const [variable, parent] of [
      ["CLAUDE_CONFIG_DIR", ".claude"],
      ["GROK_HOME", ".grok"],
      ["KIRO_HOME", ".kiro"],
    ]) {
      mkdirSync(join(home, parent), { recursive: true });
      for (const invalidRoot of [home, root]) {
        install({ [variable]: invalidRoot });
        assert.equal(existsSync(join(home, parent, "skills/orca-dag/SKILL.md")), true);
        assert.equal(existsSync(join(invalidRoot, "skills/orca-dag")), false);
      }
    }
  });

  it("never installs or uninstalls through an ancestor of an external relocated root", () => {
    const external = join(root, "external-agent-homes");
    const config = join(external, "grok");
    const skill = join(config, "skills/orca-dag");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "external user skill\n");
    const alias = join(root, "external-alias");
    symlinkSync(external, alias);
    const env = { GROK_HOME: join(alias, "grok") };
    install(env);
    uninstall(false, env);
    assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), "external user skill\n");
    assert.equal(existsSync(join(home, ".grok")), false);
  });

  for (const [agent, parent] of [
    ["Claude Code", ".claude"],
    ["Grok Build", ".grok"],
    ["Kiro CLI", ".kiro"],
    ["Cursor", ".cursor"],
    ["Gemini CLI", ".gemini"],
    ["Droid", ".factory"],
    ["Qoder", ".qoder"],
    ["CodeBuddy", ".codebuddy"],
  ]) {
    it(`keeps the default ${agent} skills directory`, () => {
      mkdirSync(join(home, parent));
      const result = install();
      assert.deepEqual(result.installed, [join(home, parent, "skills/orca-dag/SKILL.md")]);
    });
  }

  it("does not create agent directories for an agent-free home", () => {
    const result = install();
    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.upToDate, []);
    assert.deepEqual(result.skipped, null);
    assert.deepEqual(readdirSync(home), []);
  });

  it("keeps the mtime of an unchanged skill file stable", () => {
    mkdirSync(join(home, ".cursor"));
    const target = join(home, ".cursor/skills/orca-dag/SKILL.md");
    install();
    const fixed = new Date("2020-01-02T03:04:05.000Z");
    utimesSync(target, fixed, fixed);
    const before = statSync(target).mtimeMs;
    const result = install();
    assert.deepEqual(result.upToDate, [target]);
    assert.equal(statSync(target).mtimeMs, before);
  });

  it("never writes through linked config, skills or skill-file paths", () => {
    const external = join(root, "external");
    const checkout = join(external, "checkout");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "SKILL.md"), "user checkout\n");
    writeFileSync(join(checkout, "marker.txt"), "keep\n");

    mkdirSync(external, { recursive: true });
    mkdirSync(join(external, "opencode"), { recursive: true });
    symlinkSync(external, join(home, ".claude"));
    mkdirSync(join(home, ".cursor"));
    symlinkSync(checkout, join(home, ".cursor/skills"));
    mkdirSync(join(home, ".gemini/skills"), { recursive: true });
    symlinkSync(checkout, join(home, ".gemini/skills/orca-dag"));
    mkdirSync(join(home, ".factory/skills/orca-dag"), { recursive: true });
    const externalFile = join(external, "external-skill.md");
    writeFileSync(externalFile, "external file\n");
    symlinkSync(externalFile, join(home, ".factory/skills/orca-dag/SKILL.md"));
    mkdirSync(join(home, ".qoder/skills/orca-dag"), { recursive: true });
    const danglingTarget = join(external, "missing.md");
    const danglingLink = join(home, ".qoder/skills/orca-dag/SKILL.md");
    symlinkSync(danglingTarget, danglingLink);
    symlinkSync(external, join(home, ".config"));
    mkdirSync(join(home, ".codex/skills"), { recursive: true });
    symlinkSync(checkout, join(home, ".codex/skills/orca-dag"));

    const result = install();
    assert.deepEqual(result.installed, [join(home, ".agents/skills/orca-dag/SKILL.md")]);
    assert.equal(readFileSync(join(checkout, "SKILL.md"), "utf8"), "user checkout\n");
    assert.equal(readFileSync(join(checkout, "marker.txt"), "utf8"), "keep\n");
    assert.equal(readFileSync(externalFile, "utf8"), "external file\n");
    assert.equal(existsSync(danglingTarget), false);
    assert.equal(lstatSync(join(home, ".claude")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(home, ".cursor/skills")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(home, ".gemini/skills/orca-dag")).isSymbolicLink(), true);
    assert.equal(lstatSync(danglingLink).isSymbolicLink(), true);
    assert.equal(lstatSync(join(home, ".codex/skills/orca-dag")).isSymbolicLink(), true);
  });

  it("migrates a single-file legacy Codex copy into the canonical shared destination", () => {
    const legacy = join(home, ".codex/skills/orca-dag");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "stale legacy payload\n");
    const result = install();
    const canonical = join(home, ".agents/skills/orca-dag/SKILL.md");
    assert.deepEqual(result.installed, [canonical]);
    assert.equal(existsSync(legacy), false);
    assert.notEqual(readFileSync(canonical, "utf8"), "stale legacy payload\n");
  });

  it("treats an unavailable skill payload as a non-fatal skip", () => {
    const code = `import { installSkill } from ${JSON.stringify(skillUrl)}; console.log(JSON.stringify(await installSkill(${JSON.stringify(join(root, "payload-missing", "deep", "module"))}, true)));`;
    const result = JSON.parse(command(code).trim().split("\n").at(-1)!);
    assert.equal(result.skipped, "not-found");
    assert.deepEqual(result.installed, []);
  });
});

describe("skill uninstall paths", () => {
  it("previews and removes relocated, current and old legacy roots symmetrically", () => {
    const claudeRoot = join(root, "claude-config");
    const grokRoot = join(root, "grok-config");
    const kiroRoot = join(root, "kiro-config");
    for (const dir of [
      join(home, ".claude/skills/orca-dag"),
      join(home, ".cursor/skills/orca-dag"),
      join(home, ".codex/skills/orca-dag"),
      join(home, ".config/opencode/skills/orca-dag"),
      join(home, ".agents/skills/orca-dag"),
      join(claudeRoot, "skills/orca-dag"),
      join(grokRoot, "skills/orca-dag"),
      join(kiroRoot, "skills/orca-dag"),
      join(home, ".grok/skills/orca-dag"),
      join(home, ".kiro/skills/orca-dag"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "installed\n");
    }
    const env = { CLAUDE_CONFIG_DIR: claudeRoot, GROK_HOME: grokRoot, KIRO_HOME: kiroRoot };
    const dryRun = uninstall(true, env);
    for (const dir of [
      join(home, ".claude/skills/orca-dag"),
      join(home, ".cursor/skills/orca-dag"),
      join(home, ".codex/skills/orca-dag"),
      join(home, ".config/opencode/skills/orca-dag"),
      join(home, ".agents/skills/orca-dag"),
      join(claudeRoot, "skills/orca-dag"),
      join(grokRoot, "skills/orca-dag"),
      join(kiroRoot, "skills/orca-dag"),
      join(home, ".grok/skills/orca-dag"),
      join(home, ".kiro/skills/orca-dag"),
    ]) {
      assert.ok(dryRun.includes(dir.replace(home, "~")), `${dir} should be listed in the dry run`);
      assert.equal(existsSync(dir), true);
    }

    uninstall(false, env);
    for (const dir of [
      join(home, ".claude/skills/orca-dag"),
      join(home, ".cursor/skills/orca-dag"),
      join(home, ".codex/skills/orca-dag"),
      join(home, ".config/opencode/skills/orca-dag"),
      join(home, ".agents/skills/orca-dag"),
      join(claudeRoot, "skills/orca-dag"),
      join(grokRoot, "skills/orca-dag"),
      join(kiroRoot, "skills/orca-dag"),
      join(home, ".grok/skills/orca-dag"),
      join(home, ".kiro/skills/orca-dag"),
    ]) {
      assert.equal(existsSync(dir), false, `${dir} should be removed`);
    }
  });

  it("does not traverse a linked config ancestor while uninstalling", () => {
    const external = join(root, "external-config");
    const skillDir = join(external, "skills/orca-dag");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "outside the config root\n");
    symlinkSync(external, join(home, ".cursor"));
    uninstall(false);
    assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), "outside the config root\n");
  });

  it("unlinks a skill checkout link without changing the checkout", () => {
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "SKILL.md"), "user checkout\\n");
    writeFileSync(join(checkout, "marker.txt"), "keep\\n");
    const skillDir = join(home, ".cursor/skills/orca-dag");
    mkdirSync(dirname(skillDir), { recursive: true });
    symlinkSync(checkout, skillDir);

    uninstall(true);
    assert.equal(lstatSync(skillDir).isSymbolicLink(), true);
    uninstall(false);
    assert.equal(existsSync(skillDir), false);
    assert.equal(readFileSync(join(checkout, "SKILL.md"), "utf8"), "user checkout\\n");
    assert.equal(readFileSync(join(checkout, "marker.txt"), "utf8"), "keep\\n");
  });
});
