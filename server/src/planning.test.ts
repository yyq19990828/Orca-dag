import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { describePlanningSetup, removePlanningIgnore, setupPlanningWorkspace } from "./planning";
import { legacyWorkspaceStatePath, WORKSPACE_STATE_FILES } from "./workspaceState";

let root: string;
let workspace: string;
let home: string;
let ignore: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orca-dag-planning-test-"));
  workspace = join(root, "workspace");
  home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(join(home, ".claude"), { recursive: true });
  ignore = join(workspace, ".gitignore");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("planning workspace initialization", () => {
  it("adds a managed rule, really ignores plan docs, and creates no empty plan directory", () => {
    const result = setupPlanningWorkspace(workspace);
    assert.equal(result.status, "added");
    assert.match(describePlanningSetup(result), /Planning docs: \.orca-dag\/<UTC timestamp>/);
    assert.match(describePlanningSetup(result), /Added \.orca-dag\//);
    assert.equal(existsSync(join(workspace, ".orca-dag")), false);
    assert.equal(existsSync(join(workspace, ".orca")), false);
    execFileSync("git", ["init", "--quiet", workspace]);
    const doc = ".orca-dag/20261008-143012-123/PRD.md";
    assert.equal(execFileSync("git", ["-C", workspace, "check-ignore", doc], { encoding: "utf8" }).trim(), doc);
  });

  it("is idempotent without rewriting .gitignore", () => {
    setupPlanningWorkspace(workspace);
    const text = readFileSync(ignore, "utf8");
    utimesSync(ignore, new Date(0), new Date(0));
    const mtime = statSync(ignore).mtimeMs;
    assert.equal(setupPlanningWorkspace(workspace).status, "present");
    assert.equal(readFileSync(ignore, "utf8"), text);
    assert.equal(statSync(ignore).mtimeMs, mtime);
  });

  it("preserves CRLF rules and restores them when its block is removed", () => {
    const original = "node_modules/\r\n# user's existing rule\r\nprivate/\r\n";
    writeFileSync(ignore, original);
    assert.equal(setupPlanningWorkspace(workspace).status, "added");
    assert.ok(readFileSync(ignore, "utf8").startsWith(original));
    assert.equal(removePlanningIgnore(workspace, false).removed, 1);
    assert.equal(readFileSync(ignore, "utf8"), original);
    assert.equal(removePlanningIgnore(workspace, false).removed, 0);
  });

  it("adds a separator without changing a rule that had no final newline", () => {
    writeFileSync(ignore, "node_modules/");
    assert.equal(setupPlanningWorkspace(workspace).status, "added");
    assert.ok(readFileSync(ignore, "utf8").startsWith("node_modules/\n# >>>"));
    removePlanningIgnore(workspace, false);
    assert.equal(readFileSync(ignore, "utf8"), "node_modules/\n");
  });

  for (const rule of [".orca-dag/", "/.orca-dag/", ".orca-dag", "/.orca-dag", ".orca-dag/**", "/.orca-dag/**"]) {
    it(`leaves the existing user-owned ${rule} rule untouched, including on uninstall`, () => {
      const original = `# user-owned\n${rule}\nnode_modules/\n`;
      writeFileSync(ignore, original);
      assert.equal(setupPlanningWorkspace(workspace).status, "present");
      assert.equal(removePlanningIgnore(workspace, false).removed, 0);
      assert.equal(readFileSync(ignore, "utf8"), original);
    });
  }

  it("appends protection after a negation and restores the user's original choices", () => {
    const original = ".orca-dag/\n!.orca-dag/\n";
    writeFileSync(ignore, original);
    assert.equal(setupPlanningWorkspace(workspace).status, "added");
    execFileSync("git", ["init", "--quiet", workspace]);
    assert.equal(execFileSync("git", ["-C", workspace, "check-ignore", ".orca-dag/plan/PRD.md"], { encoding: "utf8" }).trim(), ".orca-dag/plan/PRD.md");
    removePlanningIgnore(workspace, false);
    assert.equal(readFileSync(ignore, "utf8"), original);
  });

  it("supports an opt-out without touching the workspace", () => {
    const result = setupPlanningWorkspace(workspace, false);
    assert.equal(result.status, "disabled");
    assert.equal(existsSync(ignore), false);
    assert.match(describePlanningSetup(result), /add \.orca-dag\/ to \.gitignore yourself/);
  });

  for (const dangling of [false, true]) {
    it(`never writes through a ${dangling ? "dangling" : "valid"} .gitignore symlink`, () => {
      const target = join(root, "user-ignore");
      if (!dangling) writeFileSync(target, "private/\n");
      symlinkSync(target, ignore);
      const result = setupPlanningWorkspace(workspace);
      assert.equal(result.status, "skipped");
      assert.match(describePlanningSetup(result), /WARNING/);
      assert.match(removePlanningIgnore(workspace, false).reason!, /left untouched/);
      if (dangling) assert.equal(existsSync(target), false);
      else assert.equal(readFileSync(target, "utf8"), "private/\n");
    });
  }

  it("reports a non-file or missing workspace without throwing", () => {
    mkdirSync(ignore);
    assert.equal(setupPlanningWorkspace(workspace).status, "skipped");
    assert.ok(removePlanningIgnore(workspace, false).reason);
    assert.equal(setupPlanningWorkspace(join(root, "missing")).status, "skipped");
    assert.equal(removePlanningIgnore(join(root, "missing"), false).removed, 0);
  });

  it("previews removal without writing and preserves later user additions", () => {
    writeFileSync(ignore, "node_modules/\n");
    setupPlanningWorkspace(workspace);
    const text = `${readFileSync(ignore, "utf8")}# added later\nprivate/\n`;
    writeFileSync(ignore, text);
    assert.equal(removePlanningIgnore(workspace, true).removed, 1);
    assert.equal(readFileSync(ignore, "utf8"), text);
    removePlanningIgnore(workspace, false);
    assert.equal(readFileSync(ignore, "utf8"), "node_modules/\n# added later\nprivate/\n");
  });

  it("keeps a managed block the user edited rather than guessing ownership", () => {
    setupPlanningWorkspace(workspace);
    const edited = readFileSync(ignore, "utf8").replace("\n.orca-dag/\n", "\n.orca-dag/private/\n");
    writeFileSync(ignore, edited);
    assert.equal(removePlanningIgnore(workspace, false).removed, 0);
    assert.equal(readFileSync(ignore, "utf8"), edited);
  });

  it("keeps legacy managed protection at startup and removes both exact blocks on uninstall", () => {
    setupPlanningWorkspace(workspace);
    const legacy = readFileSync(ignore, "utf8").replace("\n.orca-dag/\n", "\n.orca/\n");
    writeFileSync(ignore, legacy);
    assert.equal(setupPlanningWorkspace(workspace).status, "added");
    const both = readFileSync(ignore, "utf8");
    assert.ok(both.startsWith(legacy));
    assert.equal(setupPlanningWorkspace(workspace).status, "present");
    assert.equal(removePlanningIgnore(workspace, true).removed, 2);
    assert.equal(readFileSync(ignore, "utf8"), both);
    assert.equal(removePlanningIgnore(workspace, false).removed, 2);
    assert.equal(readFileSync(ignore, "utf8"), "");
  });

  it("preserves user-owned and edited legacy rules on uninstall", () => {
    setupPlanningWorkspace(workspace);
    const edited = readFileSync(ignore, "utf8").replace("\n.orca-dag/\n", "\n.orca/private/\n");
    const original = `.orca/\n${edited}`;
    writeFileSync(ignore, original);
    assert.equal(setupPlanningWorkspace(workspace).status, "added");
    assert.equal(removePlanningIgnore(workspace, false).removed, 1);
    assert.equal(readFileSync(ignore, "utf8"), original);
  });
});

// Use child processes to exercise the real subcommand/startup boundary without
// ever touching the developer's HOME or live Orca. Node as the resolved CLI
// fails any Orca probe harmlessly; only local startup/install behavior matters.
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const loader = import.meta.resolve("tsx");
function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_")) delete env[key];
  return { ...env, HOME: home, WORKSPACE_DIR: workspace, ORCA_CLI_COMMAND: JSON.stringify(process.execPath), NO_OPEN: "1", PORT: "0", ...overrides };
}

function command(args: string[]): string {
  const result = spawnSync(process.execPath, ["--import", loader, entry, ...args], {
    cwd: root, env: environment(), encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function startup(args: string[] = [], overrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const child = spawn(process.execPath, ["--import", loader, entry, ...args], {
    cwd: root, env: environment(overrides), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`Startup timed out: ${output}\n${errors}`)); }, 15_000);
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("Orca DAG viewer →")) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on("data", (chunk) => { errors += String(chunk); });
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Exited ${code}: ${output}\n${errors}`)); });
    });
    return output;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  }
}

describe("planning startup/uninstall lifecycle", () => {
  it("announces initialization and uninstalls symmetrically while keeping all plan docs, even with --purge", async () => {
    writeFileSync(ignore, "node_modules/\n");
    const plan = join(workspace, ".orca-dag", "20261008-143012-123");
    mkdirSync(plan, { recursive: true });
    writeFileSync(join(plan, "PRD.md"), "original requirements\n");
    writeFileSync(join(plan, "TECH_SPEC.md"), "original design\n");
    const output = await startup();
    assert.match(output, /Planning docs: \.orca-dag\/<UTC timestamp>/);
    assert.match(output, /Added \.orca-dag\//);
    const skill = join(home, ".claude", "skills", "orca-dag", "SKILL.md");
    assert.match(readFileSync(skill, "utf8"), /\.orca-dag\/<timestamp>\/PRD\.md/);
    const managed = readFileSync(ignore, "utf8");
    writeFileSync(join(workspace, ".orca-dag.config.json"), "{}\n");

    assert.match(command(["uninstall", "--dry-run", "--purge"]), /would remove.*managed planning ignore block\(s\) only/);
    assert.equal(readFileSync(ignore, "utf8"), managed);
    assert.ok(existsSync(skill));
    assert.ok(existsSync(join(workspace, ".orca-dag.config.json")));

    const report = command(["uninstall", "--purge"]);
    assert.match(report, /removed.*managed planning ignore block\(s\) only/);
    assert.match(report, /planning documents \(even with --purge\)/);
    assert.equal(readFileSync(ignore, "utf8"), "node_modules/\n");
    assert.equal(existsSync(skill), false);
    assert.equal(existsSync(join(workspace, ".orca-dag.config.json")), false);
    assert.equal(readFileSync(join(plan, "PRD.md"), "utf8"), "original requirements\n");
    assert.equal(readFileSync(join(plan, "TECH_SPEC.md"), "utf8"), "original design\n");
  });

  it("keeps --help and uninstall from initializing the workspace or installing a skill", () => {
    assert.match(command(["--help"]), /Startup adds a marked \.orca-dag\/ rule/);
    assert.equal(existsSync(ignore), false);
    command(["uninstall"]);
    assert.equal(existsSync(ignore), false);
    assert.equal(existsSync(join(home, ".claude", "skills")), false);
  });

  it("does not let --no-skill disable the default workspace initialization", async () => {
    assert.match(await startup(["--no-skill"]), /Added \.orca-dag\//);
    assert.equal(existsSync(join(home, ".claude", "skills")), false);
    assert.ok(existsSync(ignore));
  });

  it("supports both workspace-init opt-outs", async () => {
    assert.match(await startup(["--no-skill", "--no-workspace-init"]), /Workspace initialization disabled/);
    assert.equal(existsSync(ignore), false);
    assert.match(await startup(["--no-skill"], { ORCA_DAG_NO_WORKSPACE_INIT: "1" }), /Workspace initialization disabled/);
    assert.equal(existsSync(ignore), false);
  });

  it("never relocates or purges legacy planning documents after upgrading", async () => {
    setupPlanningWorkspace(workspace);
    const legacyRule = readFileSync(ignore, "utf8").replace("\n.orca-dag/\n", "\n.orca/\n");
    writeFileSync(ignore, legacyRule);
    const legacyPlan = join(workspace, ".orca", "20261008-143012-123");
    mkdirSync(legacyPlan, { recursive: true });
    writeFileSync(join(legacyPlan, "PRD.md"), "keep legacy requirements\n");
    assert.match(await startup(["--no-skill"]), /Added \.orca-dag\//);
    assert.equal(existsSync(join(workspace, ".orca-dag")), false);
    const report = command(["uninstall", "--purge"]);
    assert.match(report, /2 managed ignore block\(s\)/);
    assert.match(report, /\.orca — planning documents \(even with --purge\)/);
    assert.equal(readFileSync(join(legacyPlan, "PRD.md"), "utf8"), "keep legacy requirements\n");
    assert.equal(readFileSync(ignore, "utf8"), "");
  });

  it("moves all five legacy state files at startup and announces the new shared directory", async () => {
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      writeFileSync(legacyWorkspaceStatePath(workspace, file), `original ${file}\n`);
    }
    const output = await startup(["--no-skill"]);
    assert.match(output, /Workspace state: \.orca-dag\/\{config.json,activity.jsonl,launches.jsonl,requests.jsonl,sessions.json\}/);
    assert.equal(output.match(/Moved workspace state:/g)?.length, 5);
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      assert.equal(readFileSync(join(workspace, file), "utf8"), `original ${file}\n`);
      assert.equal(existsSync(legacyWorkspaceStatePath(workspace, file)), false);
    }
  });

  it("does not move an older viewer's state when its port is already in use", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => { occupied.listen(0, "127.0.0.1", resolve); });
    const addr = occupied.address();
    assert.ok(addr && typeof addr !== "string");
    const legacy = legacyWorkspaceStatePath(workspace, WORKSPACE_STATE_FILES.config);
    writeFileSync(legacy, '{"runId":"run_old"}\n');
    try {
      const result = spawnSync(process.execPath, ["--import", loader, entry, "--no-skill"], {
        cwd: root, env: environment({ PORT: String(addr.port) }), encoding: "utf8", timeout: 15_000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EADDRINUSE/);
      assert.equal(readFileSync(legacy, "utf8"), '{"runId":"run_old"}\n');
      assert.equal(existsSync(join(workspace, WORKSPACE_STATE_FILES.config)), false);
    } finally {
      await new Promise<void>((resolve) => { occupied.close(() => resolve()); });
    }
  });

  it("keeps state by default and purges only known files in both layouts, never plans or extra files", () => {
    const plan = join(workspace, ".orca-dag", "20261008-143012-123");
    mkdirSync(plan, { recursive: true });
    writeFileSync(join(plan, "PRD.md"), "keep requirements\n");
    const extra = join(workspace, ".orca-dag", "notes.md");
    writeFileSync(extra, "keep notes\n");
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      writeFileSync(join(workspace, file), `current ${file}\n`);
      writeFileSync(legacyWorkspaceStatePath(workspace, file), `legacy ${file}\n`);
    }
    command(["uninstall"]);
    command(["uninstall", "--dry-run", "--purge"]);
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      assert.equal(readFileSync(join(workspace, file), "utf8"), `current ${file}\n`);
      assert.equal(readFileSync(legacyWorkspaceStatePath(workspace, file), "utf8"), `legacy ${file}\n`);
    }
    command(["uninstall", "--purge"]);
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      assert.equal(existsSync(join(workspace, file)), false);
      assert.equal(existsSync(legacyWorkspaceStatePath(workspace, file)), false);
    }
    assert.equal(readFileSync(join(plan, "PRD.md"), "utf8"), "keep requirements\n");
    assert.equal(readFileSync(extra, "utf8"), "keep notes\n");
  });

  it("never follows a symlinked shared directory during uninstall --purge", () => {
    const external = join(root, "external");
    mkdirSync(external);
    const target = join(external, "config.json");
    writeFileSync(target, "keep external config\n");
    symlinkSync(external, join(workspace, ".orca-dag"));
    assert.match(command(["uninstall", "--purge"]), /must be a real directory; left untouched/);
    assert.equal(readFileSync(target, "utf8"), "keep external config\n");
  });
});
