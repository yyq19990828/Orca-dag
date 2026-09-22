import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config";

/**
 * Config sanitization coverage (plan §9.1) for the Phase 5 field. The shape
 * contract is the same as modelByTask; what is actually new is the
 * compatibility guarantee: a pre-Phase-5 file lacks `effortByTask` entirely,
 * and hydration must leave it undefined rather than inventing an empty map —
 * "config hydration remains backward compatible with files lacking the new
 * maps" is an explicit acceptance criterion.
 */

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-dag-config-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config: effortByTask (Phase 5)", () => {
  it("round-trips a well-formed effort map through save + load", async () => {
    await saveConfig(dir, { effortByTask: { task_a: "high", task_b: "low" } });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.effortByTask, { task_a: "high", task_b: "low" });
  });

  it("drops malformed entries and keeps the well-typed rest", async () => {
    await saveConfig(dir, { effortByTask: { ok: "medium", empty: "   ", not_a_string: 42 } });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.effortByTask, { ok: "medium" });
  });

  it("hydrates a pre-Phase-5 file without the key (backward compatible)", async () => {
    // A file written by an older viewer: no effortByTask at all, plus a
    // unknown key the allowlist sanitizer must keep dropping.
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({
        defaultHarness: "claude",
        modelByTask: { task_1: "opus" },
        someFutureKey: { nested: true },
      }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.defaultHarness, "claude");
    assert.deepEqual(loaded.modelByTask, { task_1: "opus" });
    assert.equal(loaded.effortByTask, undefined, "absent stays absent — no invented empty map");
    assert.equal((loaded as Record<string, unknown>).someFutureKey, undefined);
  });

  it("ignores a non-object effortByTask instead of poisoning the config", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({ effortByTask: ["high"], defaultHarness: "codex" }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.effortByTask, undefined);
    assert.equal(loaded.defaultHarness, "codex", "the rest of the file still loads");
  });
});

/**
 * Phase 6 fields: `environmentByTask` (saved-environment selectors) and
 * `placementByTask` (exact placement specs). The compatibility guarantee is
 * the same one Phase 5 pinned: a pre-Phase-6 file lacks both keys entirely and
 * must hydrate untouched — local/current stays the zero-configuration default.
 */
describe("config: environmentByTask + placementByTask (Phase 6)", () => {
  it("round-trips an environment map and drops malformed entries", async () => {
    await saveConfig(dir, {
      environmentByTask: { task_a: "env_remote", task_b: "   ", task_c: 42 },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.environmentByTask, { task_a: "env_remote" });
  });

  it("round-trips all four placement kinds and their creation metadata", async () => {
    await saveConfig(dir, {
      placementByTask: {
        task_local: { kind: "current" },
        task_existing: { kind: "existing", selector: "id:repoA::/srv/ws" },
        task_child: {
          kind: "new-child",
          name: "kid-wt",
          setup: "inherit",
          baseBranch: "feature/x",
          displayName: "Kid worktree",
          comment: "stacked lane",
        },
        task_new: {
          kind: "new-top-level",
          repo: "id:repoA",
          name: "phase6-wt",
          setup: "skip",
          baseBranch: "main",
        },
      },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.placementByTask, {
      task_local: { kind: "current" },
      task_existing: { kind: "existing", selector: "id:repoA::/srv/ws" },
      task_child: {
        kind: "new-child",
        name: "kid-wt",
        setup: "inherit",
        baseBranch: "feature/x",
        displayName: "Kid worktree",
        comment: "stacked lane",
      },
      task_new: { kind: "new-top-level", repo: "id:repoA", name: "phase6-wt", setup: "skip", baseBranch: "main" },
    });
  });

  it("normalizes an absent setup policy to Orca's default run (old and new files alike)", async () => {
    await saveConfig(dir, {
      placementByTask: {
        no_setup: { kind: "new-top-level", repo: "id:repoA", name: "wt" },
      },
    });
    const loaded = await loadConfig(dir);
    assert.equal(
      (loaded.placementByTask?.no_setup as { setup: string }).setup,
      "run",
    );
  });

  it("keeps a nameless creation placement (the server derives a bounded name at start)", async () => {
    await saveConfig(dir, {
      placementByTask: {
        derived: { kind: "new-child", setup: "run" },
        derived_top: { kind: "new-top-level", repo: "id:repoA", setup: "skip" },
      },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.placementByTask?.derived, { kind: "new-child", setup: "run" });
    assert.deepEqual(loaded.placementByTask?.derived_top, {
      kind: "new-top-level",
      repo: "id:repoA",
      setup: "skip",
    });
  });

  it("drops structurally malformed entries instead of guessing a shape", async () => {
    await saveConfig(dir, {
      placementByTask: {
        bad_kind: { kind: "new-sibling" }, // no such kind — dropped outright
        missing_selector: { kind: "existing" },
        empty_selector: { kind: "existing", selector: "  " },
        missing_repo: { kind: "new-top-level", name: "wt" },
        not_object: "path:/srv/ws",
        extra_keys_survive: { kind: "existing", selector: "path:/srv/ws", host: "nope" },
      },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.placementByTask, {
      extra_keys_survive: { kind: "existing", selector: "path:/srv/ws" },
    });
  });

  it("strips malformed creation fields field-by-field, keeping the safe placement", async () => {
    await saveConfig(dir, {
      placementByTask: {
        child: {
          kind: "new-child",
          name: "bad name; rm", // not a bounded single token — stripped
          setup: "yolo", // not a policy — normalized to run
          baseBranch: "../escape", // ref traversal — stripped
          displayName: "ok display",
          comment: "x".repeat(501), // over the bound — stripped
        },
        // Creation fields on a current/existing placement are meaningless and
        // stripped; the SAFE part of the intent (the exact selector) survives.
        existing_with_setup: { kind: "existing", selector: "path:/srv/ws", setup: "skip", name: "wt" },
      },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.placementByTask?.child, {
      kind: "new-child",
      setup: "run",
      displayName: "ok display",
    });
    assert.deepEqual(loaded.placementByTask?.existing_with_setup, {
      kind: "existing",
      selector: "path:/srv/ws",
    });
  });

  it("hydrates a pre-Phase-6 file without inventing the new maps", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({ defaultHarness: "claude", modelByTask: { task_1: "opus" } }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.environmentByTask, undefined, "absent stays absent — local/current default");
    assert.equal(loaded.placementByTask, undefined);
    assert.equal(loaded.defaultHarness, "claude");
  });

  it("ignores a non-object placementByTask instead of poisoning the config", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({ placementByTask: [{ kind: "current" }], runId: "run_1" }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.placementByTask, undefined);
    assert.equal(loaded.runId, "run_1", "the rest of the file still loads");
  });
});

describe("config: leadTaskByRun", () => {
  it("round-trips one explicit lead Task per Run", async () => {
    await saveConfig(dir, {
      leadTaskByRun: { run_a: "task_lead_a", run_b: "task_lead_b" },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.leadTaskByRun, {
      run_a: "task_lead_a",
      run_b: "task_lead_b",
    });
  });

  it("replaces the submitted map so clearing one Run preserves the others", async () => {
    await saveConfig(dir, {
      leadTaskByRun: { run_a: "task_lead_a", run_b: "task_lead_b" },
    });
    await saveConfig(dir, { leadTaskByRun: { run_b: "task_lead_b" } });
    assert.deepEqual((await loadConfig(dir)).leadTaskByRun, {
      run_b: "task_lead_b",
    });
  });

  it("loads an older config without inventing lead-stage metadata", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({ defaultHarness: "claude", runId: "run_old" }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.leadTaskByRun, undefined);
    assert.equal(loaded.runId, "run_old");
  });

  it("drops malformed lead entries while keeping valid Run-to-Task pairs", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({
        leadTaskByRun: {
          run_ok: " task_ok ",
          run_empty: "   ",
          run_number: 42,
          "": "task_blank_run",
        },
      }),
    );
    assert.deepEqual((await loadConfig(dir)).leadTaskByRun, { run_ok: "task_ok" });
  });
});

/**
 * Worktree-lane persistence (placement foundation). A lane is launch intent
 * only — one seed placement shared by a dependency-ordered task chain. The
 * sanitizer must keep well-formed lanes verbatim, drop lanes seeded by
 * `current` (a "current lane" is the default, not a lane), and keep the
 * task→lane membership map trim-tight like every other id map.
 */
describe("config: worktreeLanes + laneByTask (placement foundation)", () => {
  it("round-trips lanes seeded by each non-current placement kind", async () => {
    await saveConfig(dir, {
      worktreeLanes: {
        lane_existing: { placement: { kind: "existing", selector: "id:repoA::/srv/ws" } },
        lane_child: { placement: { kind: "new-child", name: "kid", setup: "inherit" } },
        lane_top: { placement: { kind: "new-top-level", repo: "id:repoA", setup: "run" } },
      },
      laneByTask: { task_1: "lane_child", task_2: " lane_child " },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.worktreeLanes, {
      lane_existing: { placement: { kind: "existing", selector: "id:repoA::/srv/ws" } },
      lane_child: { placement: { kind: "new-child", name: "kid", setup: "inherit" } },
      lane_top: { placement: { kind: "new-top-level", repo: "id:repoA", setup: "run" } },
    });
    assert.deepEqual(loaded.laneByTask, { task_1: "lane_child", task_2: "lane_child" });
  });

  it("drops a lane seeded by current and other malformed lane entries", async () => {
    await saveConfig(dir, {
      worktreeLanes: {
        lane_current: { placement: { kind: "current" } }, // no such thing as a current lane
        lane_broken: { placement: { kind: "new-top-level" } }, // no repo
        lane_not_object: "path:/srv/ws",
        lane_ok: { placement: { kind: "new-child", setup: "skip" } },
      },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.worktreeLanes, {
      lane_ok: { placement: { kind: "new-child", setup: "skip" } },
    });
  });

  it("keeps lane membership of dropped lanes (conflict checks are validation's job)", async () => {
    await saveConfig(dir, {
      worktreeLanes: { lane_ok: { placement: { kind: "new-child" } } },
      laneByTask: { task_dangling: "lane_missing", task_ok: "lane_ok", task_blank: "  " },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.laneByTask, { task_dangling: "lane_missing", task_ok: "lane_ok" });
  });
});
